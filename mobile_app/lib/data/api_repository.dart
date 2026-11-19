import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import '../core/config.dart';
import 'models.dart';
import 'repository.dart';

/// Talks to the Express backend (REST under /api/v1) and its Socket.IO gateway.
/// Endpoint shapes follow PLAN_AND_ARCHITECTURE.md §7; adjust here if the
/// backend contract changes.
class ApiWaterRepository implements WaterRepository {
  ApiWaterRepository({Dio? dio, FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage(),
        _dio = dio ??
            Dio(BaseOptions(
              baseUrl: AppConfig.apiBaseUrl,
              connectTimeout: const Duration(seconds: 10),
              receiveTimeout: const Duration(seconds: 20),
              contentType: 'application/json',
            )) {
    _dio.interceptors.add(QueuedInterceptorsWrapper(
      onRequest: (options, handler) {
        if (_accessToken != null) options.headers['Authorization'] = 'Bearer $_accessToken';
        handler.next(options);
      },
      onError: (error, handler) async {
        final isAuthCall = error.requestOptions.path.startsWith('/auth/');
        if (error.response?.statusCode == 401 && !isAuthCall && await _refresh()) {
          final retry = error.requestOptions..headers['Authorization'] = 'Bearer $_accessToken';
          try {
            return handler.resolve(await _dio.fetch(retry));
          } on DioException catch (e) {
            return handler.next(e);
          }
        }
        handler.next(error);
      },
    ));
  }

  static const _refreshKey = 'swm_refresh_token';

  final Dio _dio;
  final FlutterSecureStorage _storage;
  String? _accessToken;
  io.Socket? _socket;

  // ------------------------------------------------------------- helpers

  Future<T> _call<T>(Future<Response<dynamic>> Function() request, T Function(dynamic data) parse) async {
    try {
      final res = await request();
      return parse(res.data);
    } on DioException catch (e) {
      final data = e.response?.data;
      final msg = data is Map && data['message'] is String
          ? data['message'] as String
          : e.type == DioExceptionType.connectionError || e.type == DioExceptionType.connectionTimeout
              ? 'Cannot reach the server. Check your connection.'
              : 'Something went wrong (${e.response?.statusCode ?? e.type.name}).';
      throw RepositoryException(msg);
    }
  }

  Map<String, dynamic> _map(dynamic d) => d as Map<String, dynamic>;
  List<Map<String, dynamic>> _list(dynamic d) => (d as List).cast<Map<String, dynamic>>();

  Future<void> _saveTokens(Map<String, dynamic> j) async {
    _accessToken = j['accessToken'] as String;
    await _storage.write(key: _refreshKey, value: j['refreshToken'] as String);
  }

  Future<bool> _refresh() async {
    final refresh = await _storage.read(key: _refreshKey);
    if (refresh == null) return false;
    try {
      final res = await _dio.post('/auth/refresh', data: {'refreshToken': refresh});
      await _saveTokens(_map(res.data));
      return true;
    } on DioException {
      await _storage.delete(key: _refreshKey);
      _accessToken = null;
      return false;
    }
  }

  io.Socket _ensureSocket() {
    final existing = _socket;
    if (existing != null) return existing;
    final s = io.io(
      AppConfig.socketUrl,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .setAuth({'token': _accessToken})
          .disableAutoConnect()
          .enableReconnection()
          .build(),
    );
    s.connect();
    return _socket = s;
  }

  // ---------------------------------------------------------------- auth

  @override
  Future<void> requestOtp(String identifier) =>
      _call(() => _dio.post('/auth/otp/request', data: {'identifier': identifier.trim()}), (_) {});

  @override
  Future<Customer> verifyOtp(String identifier, String code) async {
    final j = await _call(
      () => _dio.post('/auth/otp/verify', data: {'identifier': identifier.trim(), 'code': code}),
      _map,
    );
    await _saveTokens(j);
    return Customer.fromJson(_map(j['customer']));
  }

  @override
  Future<Customer?> restoreSession() async {
    if (!await _refresh()) return null;
    return _call(() => _dio.get('/me'), (d) => Customer.fromJson(_map(d)));
  }

  @override
  Future<Customer> updateProfile({required String name, String? email, String? phone}) => _call(
        () => _dio.patch('/me', data: {'name': name, 'email': email, 'phone': phone}),
        (d) => Customer.fromJson(_map(d)),
      );

  @override
  Future<void> logout() async {
    final refresh = await _storage.read(key: _refreshKey);
    try {
      await _dio.post('/auth/logout', data: {'refreshToken': refresh});
    } on DioException {
      // Logging out locally is enough if the server is unreachable.
    }
    await _storage.delete(key: _refreshKey);
    _accessToken = null;
    _socket?.dispose();
    _socket = null;
  }

  // ------------------------------------------------------- accounts/meter

  @override
  Future<List<Account>> getAccounts() =>
      _call(() => _dio.get('/accounts'), (d) => _list(d).map(Account.fromJson).toList());

  @override
  Future<Account> claimMeter({required String meterId, required String claimCode, required String label}) => _call(
        () => _dio.post('/meters/claim', data: {'meterId': meterId, 'claimCode': claimCode, 'label': label}),
        (d) => Account.fromJson(_map(d)),
      );

  @override
  Future<MeterSummary> getSummary(String meterId) =>
      _call(() => _dio.get('/meters/$meterId/summary'), (d) => MeterSummary.fromJson(_map(d)));

  @override
  Stream<LiveReading> liveFlow(String meterId) {
    late StreamController<LiveReading> controller;
    Timer? renew;
    void onLive(dynamic data) {
      final j = _map(data);
      if (j['meterId'] == meterId) controller.add(LiveReading.fromJson(j));
    }

    Future<void> startLive() async {
      try {
        await _dio.post('/meters/$meterId/live');
      } on DioException {
        // Live mode is best effort; the summary still refreshes on its own.
      }
    }

    controller = StreamController<LiveReading>(
      onListen: () {
        final s = _ensureSocket();
        s.emit('subscribe', {'meterId': meterId});
        s.on('meter:live', onLive);
        startLive();
        // The meter stops live mode after its TTL (120 s), so renew while watched.
        renew = Timer.periodic(const Duration(seconds: 60), (_) => startLive());
      },
      onCancel: () {
        renew?.cancel();
        _socket?.off('meter:live', onLive);
        _socket?.emit('unsubscribe', {'meterId': meterId});
      },
    );
    return controller.stream;
  }

  @override
  Stream<ValveState> setValve(String meterId, {required bool open}) async* {
    final s = _ensureSocket()..emit('subscribe', {'meterId': meterId});
    final result = Completer<ValveState>();
    String? cmdId;

    void onValve(dynamic data) {
      final j = _map(data);
      if (j['meterId'] != meterId || (cmdId != null && j['cmdId'] != cmdId)) return;
      switch (j['state']) {
        case 'CONFIRMED' || 'EXECUTED':
          if (!result.isCompleted) {
            result.complete(j['valve'] == 'closed' ? ValveState.closed : ValveState.open);
          }
        case 'FAILED' || 'TIMEOUT':
          if (!result.isCompleted) {
            result.completeError(RepositoryException(j['error'] as String? ?? 'The meter did not respond.'));
          }
      }
    }

    s.on('meter:valve', onValve);
    try {
      yield open ? ValveState.opening : ValveState.closing;
      cmdId = await _call(
        () => _dio.post('/meters/$meterId/valve', data: {'action': open ? 'OPEN' : 'CLOSE'}),
        (d) => _map(d)['cmdId'] as String,
      );
      yield await result.future.timeout(
        AppConfig.valveTimeout,
        onTimeout: () => throw RepositoryException('No confirmation from the meter. Check that it is online.'),
      );
    } finally {
      s.off('meter:valve', onValve);
    }
  }

  @override
  Future<UsageSeries> getUsage(String meterId, UsageRange range) => _call(
        () => _dio.get('/meters/$meterId/usage', queryParameters: {'range': range.name}),
        (d) => UsageSeries.fromJson(range, _map(d)),
      );

  // ------------------------------------------------------------- billing

  @override
  Future<Tariff> getActiveTariff() => _call(() => _dio.get('/tariffs/active'), (d) => Tariff.fromJson(_map(d)));

  @override
  Future<Balance> getBalance(String accountId) =>
      _call(() => _dio.get('/accounts/$accountId/balance'), (d) => Balance.fromJson(_map(d)));

  @override
  Future<List<Bill>> getBills(String accountId) =>
      _call(() => _dio.get('/accounts/$accountId/bills'), (d) => _list(d).map(Bill.fromJson).toList());

  @override
  Future<Bill> getCurrentEstimate(String accountId) => _call(
        () => _dio.get('/bills/estimate', queryParameters: {'accountId': accountId}),
        (d) => Bill.fromJson(_map(d)),
      );

  /// Sandbox payment. A real gateway would return a checkout URL to open in a
  /// WebView and confirm the result through the backend webhook.
  @override
  Future<PaymentResult> pay({required String accountId, required int amountCents}) => _call(
        () => _dio.post('/payments/checkout', data: {'accountId': accountId, 'amountCents': amountCents}),
        (d) {
          final j = _map(d);
          return PaymentResult(
            success: j['status'] == 'SUCCESS',
            reference: j['reference'] as String? ?? '',
            message: j['message'] as String?,
          );
        },
      );

  // ------------------------------------------------ alerts/settings/support

  @override
  Future<List<AppAlert>> getAlerts() =>
      _call(() => _dio.get('/alerts'), (d) => _list(d).map(AppAlert.fromJson).toList());

  @override
  Future<void> markAlertRead(String alertId) =>
      _call(() => _dio.patch('/alerts/$alertId', data: {'read': true}), (_) {});

  @override
  Future<AccountSettings> getSettings(String accountId) =>
      _call(() => _dio.get('/accounts/$accountId/settings'), (d) => AccountSettings.fromJson(_map(d)));

  @override
  Future<AccountSettings> saveSettings(String accountId, AccountSettings settings) => _call(
        () => _dio.put('/accounts/$accountId/settings', data: settings.toJson()),
        (d) => AccountSettings.fromJson(_map(d)),
      );

  @override
  Future<List<Ticket>> getTickets() =>
      _call(() => _dio.get('/tickets'), (d) => _list(d).map(Ticket.fromJson).toList());

  @override
  Future<Ticket> createTicket({required String category, required String subject, required String description}) =>
      _call(
        () => _dio.post('/tickets', data: {'category': category, 'subject': subject, 'description': description}),
        (d) => Ticket.fromJson(_map(d)),
      );
}
