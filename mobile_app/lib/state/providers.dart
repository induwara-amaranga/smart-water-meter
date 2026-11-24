import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/config.dart';
import '../data/api_repository.dart';
import '../data/mock_repository.dart';
import '../data/models.dart';
import '../data/provisioning.dart';
import '../data/repository.dart';

// ------------------------------------------------------------------ refresh

/// How often REST-backed metrics re-fetch while watched. Live flow and valve
/// state come over the socket and are not polled.
const metricsRefresh = Duration(seconds: 5);

/// Re-fetches the calling provider every [metricsRefresh]. Riverpod keeps the
/// previous value while refreshing, so screens do not flash a spinner.
void _autoRefresh(Ref ref) {
  final timer = Timer(metricsRefresh, ref.invalidateSelf);
  ref.onDispose(timer.cancel);
}

// ------------------------------------------------------------------ services

final repositoryProvider = Provider<WaterRepository>(
  (ref) => AppConfig.useMock ? MockWaterRepository() : ApiWaterRepository(),
);

final provisioningProvider = Provider<ProvisioningService>(
  (ref) => AppConfig.useMock ? MockProvisioningService() : CloudCheckProvisioningService(ref.read(repositoryProvider)),
);

// ---------------------------------------------------------------------- auth

class AuthController extends AsyncNotifier<Customer?> {
  WaterRepository get _repo => ref.read(repositoryProvider);

  @override
  Future<Customer?> build() => _repo.restoreSession();

  Future<void> requestOtp(String identifier) => _repo.requestOtp(identifier);

  /// Throws [RepositoryException] on a wrong code so the OTP screen can show it.
  Future<void> verifyOtp(String identifier, String code) async {
    final customer = await _repo.verifyOtp(identifier, code);
    state = AsyncData(customer);
  }

  Future<void> updateProfile({required String name, String? email, String? phone}) async {
    state = AsyncData(await _repo.updateProfile(name: name, email: email, phone: phone));
  }

  Future<void> logout() async {
    await _repo.logout();
    ref.read(selectedAccountIdProvider.notifier).select(null);
    state = const AsyncData(null);
  }
}

final authProvider = AsyncNotifierProvider<AuthController, Customer?>(AuthController.new);

// ------------------------------------------------------------------ accounts

final accountsProvider = FutureProvider<List<Account>>((ref) async {
  final customer = await ref.watch(authProvider.future);
  if (customer == null) return const [];
  return ref.watch(repositoryProvider).getAccounts();
});

class SelectedAccountId extends Notifier<String?> {
  @override
  String? build() => null;

  void select(String? id) => state = id;
}

final selectedAccountIdProvider = NotifierProvider<SelectedAccountId, String?>(SelectedAccountId.new);

/// The account shown across the app: the one picked in the switcher, else the first.
final currentAccountProvider = Provider<Account?>((ref) {
  final accounts = ref.watch(accountsProvider).value ?? const <Account>[];
  if (accounts.isEmpty) return null;
  final selected = ref.watch(selectedAccountIdProvider);
  return accounts.firstWhere((a) => a.id == selected, orElse: () => accounts.first);
});

// --------------------------------------------------------------------- meter

final summaryProvider = FutureProvider.family<MeterSummary, String>((ref, meterId) async {
  _autoRefresh(ref);
  return ref.watch(repositoryProvider).getSummary(meterId);
});

final liveFlowProvider = StreamProvider.autoDispose.family<LiveReading, String>(
  (ref, meterId) => ref.watch(repositoryProvider).liveFlow(meterId),
);

/// UI state for the valve switch, including the in-between "Closing..." state.
class ValveUiState {
  const ValveUiState(this.state, {this.error});

  final ValveState? state;
  final String? error;

  bool get busy => state == ValveState.opening || state == ValveState.closing;
}

class ValveController extends Notifier<ValveUiState> {
  ValveController(this.meterId);

  final String meterId;
  StreamSubscription<ValveState>? _sub;

  @override
  ValveUiState build() {
    ref.onDispose(() => _sub?.cancel());
    // Listen rather than watch: in Riverpod 3 a watched dependency recreates the
    // notifier, which would drop an in-flight command and its "Closing..." state.
    ref.listen(summaryProvider(meterId), (_, next) {
      final valve = next.value?.valve;
      if (valve != null && !state.busy) state = ValveUiState(valve);
    });
    return ValveUiState(ref.read(summaryProvider(meterId)).value?.valve);
  }

  void set({required bool open}) {
    if (state.busy) return;
    _sub?.cancel();
    _sub = ref
        .read(repositoryProvider)
        .setValve(meterId, open: open)
        .listen(
          (s) => state = ValveUiState(s),
          onError: (Object e) {
            state = ValveUiState(open ? ValveState.closed : ValveState.open, error: e.toString());
          },
          onDone: () => ref.invalidate(summaryProvider(meterId)),
        );
  }
}

final valveProvider = NotifierProvider.autoDispose.family<ValveController, ValveUiState, String>(ValveController.new);

final usageProvider = FutureProvider.autoDispose.family<UsageSeries, (String, UsageRange)>(
  (ref, args) {
    _autoRefresh(ref);
    return ref.watch(repositoryProvider).getUsage(args.$1, args.$2);
  },
);

// ------------------------------------------------------------------- billing

final tariffProvider = FutureProvider<Tariff>((ref) => ref.watch(repositoryProvider).getActiveTariff());

final balanceProvider = FutureProvider.family<Balance, String>(
  (ref, accountId) {
    _autoRefresh(ref);
    return ref.watch(repositoryProvider).getBalance(accountId);
  },
);

final billsProvider = FutureProvider.family<List<Bill>, String>(
  (ref, accountId) {
    _autoRefresh(ref);
    return ref.watch(repositoryProvider).getBills(accountId);
  },
);

final estimateProvider = FutureProvider.autoDispose.family<Bill, String>(
  (ref, accountId) {
    _autoRefresh(ref);
    return ref.watch(repositoryProvider).getCurrentEstimate(accountId);
  },
);

// -------------------------------------------------------- alerts & settings

final alertsProvider = FutureProvider<List<AppAlert>>((ref) async {
  _autoRefresh(ref);
  final customer = await ref.watch(authProvider.future);
  if (customer == null) return const [];
  return ref.watch(repositoryProvider).getAlerts();
});

final unreadAlertCountProvider = Provider<int>(
  (ref) => ref.watch(alertsProvider).value?.where((a) => !a.read).length ?? 0,
);

final settingsProvider = FutureProvider.family<AccountSettings, String>(
  (ref, accountId) => ref.watch(repositoryProvider).getSettings(accountId),
);

final ticketsProvider = FutureProvider.autoDispose<List<Ticket>>((ref) => ref.watch(repositoryProvider).getTickets());
