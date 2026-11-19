import 'dart:async';
import 'dart:math';

import '../core/config.dart';
import '../core/tariff_calculator.dart';
import 'models.dart';
import 'repository.dart';

/// In-memory backend with a simulated meter, so the app can be built and demoed
/// before the Express backend and the ESP32 hardware are ready.
class MockWaterRepository implements WaterRepository {
  MockWaterRepository() {
    _seed();
  }

  static const _latency = Duration(milliseconds: 450);
  final _rand = Random(35);

  Customer? _customer;
  final List<Account> _accounts = [];
  final Map<String, _SimMeter> _meters = {};
  final Map<String, AccountSettings> _settings = {};
  final Map<String, int> _paidCents = {};
  final Map<String, ({int cents, DateTime at})> _lastPayment = {};
  final List<AppAlert> _alerts = [];
  final List<Ticket> _tickets = [];

  final Tariff _tariff = Tariff(
    name: 'Domestic 2026',
    slabs: const [
      TariffSlab(upToM3: 10, rateCents: 1000),
      TariffSlab(upToM3: 20, rateCents: 1500),
      TariffSlab(upToM3: null, rateCents: 2500),
    ],
    serviceChargeCents: 40000,
    effectiveFrom: DateTime(2026, 1, 1),
  );

  /// Meters that exist "in the field" and can be claimed with their code.
  final Map<String, String> _claimable = {'SWM-000789': 'ABCD-1234', 'SWM-000999': 'WXYZ-9876'};

  void _seed() {
    _addAccount(
      const Account(
        id: 'acc-1',
        accountNo: '10/43/546/022/11',
        label: 'Home',
        address: '12 Lake Road, Kotte',
        meterId: 'SWM-000123',
        holderName: 'Demo Customer',
      ),
      startLiters: 412340,
      budget: 15,
    );
    _addAccount(
      const Account(
        id: 'acc-2',
        accountNo: '10/43/546/087/02',
        label: 'Parents',
        address: '5 Temple Lane, Piliyandala',
        meterId: 'SWM-000456',
        holderName: 'Demo Customer',
      ),
      startLiters: 198775,
      budget: null,
    );

    final now = DateTime.now();
    _alerts.addAll([
      AppAlert(
        id: 'al-1',
        type: AlertType.billing,
        severity: AlertSeverity.warning,
        title: 'Bill due in 3 days',
        message: 'Your ${formatPeriod(DateTime(now.year, now.month - 1))} bill is due soon.',
        createdAt: now.subtract(const Duration(hours: 5)),
        meterId: 'SWM-000123',
      ),
      AppAlert(
        id: 'al-2',
        type: AlertType.notice,
        severity: AlertSeverity.info,
        title: 'Planned interruption',
        message: 'Water supply in Kotte will be interrupted on Saturday 9 AM – 1 PM for pipeline maintenance.',
        createdAt: now.subtract(const Duration(days: 1, hours: 2)),
      ),
      AppAlert(
        id: 'al-3',
        type: AlertType.highUsage,
        severity: AlertSeverity.warning,
        title: '80% of monthly budget used',
        message: 'You have used 12.1 m³ of your 15 m³ budget for this month.',
        createdAt: now.subtract(const Duration(days: 3)),
        meterId: 'SWM-000123',
        read: true,
      ),
      AppAlert(
        id: 'al-4',
        type: AlertType.device,
        severity: AlertSeverity.info,
        title: 'Meter back online',
        message: 'SWM-000456 reconnected and uploaded 14 buffered readings.',
        createdAt: now.subtract(const Duration(days: 6)),
        meterId: 'SWM-000456',
        read: true,
      ),
    ]);

    _tickets.add(Ticket(
      id: 'TK-1042',
      category: 'Billing',
      subject: 'Query about arrears on last bill',
      description: 'The previous bill shows arrears although I paid on time.',
      status: TicketStatus.resolved,
      createdAt: now.subtract(const Duration(days: 20)),
    ));
  }

  void _addAccount(Account a, {required double startLiters, required double? budget}) {
    _accounts.add(a);
    _meters[a.meterId] = _SimMeter(a.meterId, startLiters, _rand.nextInt(1 << 20));
    _settings[a.id] = AccountSettings(budgetM3: budget);
  }

  static String formatPeriod(DateTime d) {
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    return '${months[d.month - 1]} ${d.year}';
  }

  Future<T> _delay<T>(T Function() f) => Future.delayed(_latency, f);

  _SimMeter _meter(String meterId) =>
      _meters[meterId] ?? (throw RepositoryException('Unknown meter $meterId'));

  Account _account(String accountId) => _accounts.firstWhere(
        (a) => a.id == accountId,
        orElse: () => throw RepositoryException('Unknown account $accountId'),
      );

  // ---------------------------------------------------------------- auth

  @override
  Future<void> requestOtp(String identifier) => _delay(() {
        if (identifier.trim().length < 5) throw RepositoryException('Enter a valid phone number or email');
      });

  @override
  Future<Customer> verifyOtp(String identifier, String code) => _delay(() {
        if (code != AppConfig.mockOtp) throw RepositoryException('Incorrect code. Try ${AppConfig.mockOtp}.');
        final isEmail = identifier.contains('@');
        return _customer = Customer(
          id: 'cus-1',
          name: 'Demo Customer',
          phone: isEmail ? null : identifier,
          email: isEmail ? identifier : null,
        );
      });

  @override
  Future<Customer?> restoreSession() async => _customer;

  @override
  Future<Customer> updateProfile({required String name, String? email, String? phone}) => _delay(() {
        return _customer = _customer!.copyWith(name: name, email: email, phone: phone);
      });

  @override
  Future<void> logout() async => _customer = null;

  // ------------------------------------------------------- accounts/meter

  @override
  Future<List<Account>> getAccounts() => _delay(() => List.unmodifiable(_accounts));

  @override
  Future<Account> claimMeter({required String meterId, required String claimCode, required String label}) =>
      _delay(() {
        final id = meterId.trim().toUpperCase();
        if (_meters.containsKey(id)) throw RepositoryException('This meter is already linked to an account.');
        final code = _claimable[id];
        if (code == null || code != claimCode.trim().toUpperCase()) {
          throw RepositoryException('Meter ID or claim code is incorrect.');
        }
        final account = Account(
          id: 'acc-${_accounts.length + 1}',
          accountNo: '10/43/546/${100 + _accounts.length}/01',
          label: label.trim().isEmpty ? 'Meter ${_accounts.length + 1}' : label.trim(),
          address: 'New connection',
          meterId: id,
          holderName: _customer?.name ?? 'Customer',
        );
        _addAccount(account, startLiters: 0, budget: null);
        _claimable.remove(id);
        return account;
      });

  @override
  Future<MeterSummary> getSummary(String meterId) => _delay(() {
        final m = _meter(meterId)..tick();
        final account = _accounts.firstWhere((a) => a.meterId == meterId);
        final monthM3 = m.monthUsageLiters / 1000;
        final unread = _alerts
            .where((a) => !a.read && (a.meterId == null || a.meterId == meterId))
            .toList()
          ..sort((a, b) => b.severity.index.compareTo(a.severity.index));
        return MeterSummary(
          meterId: meterId,
          online: m.online,
          lastSeen: m.lastSeen,
          flowLpm: m.flowLpm,
          totalLiters: m.totalLiters,
          monthUsageM3: monthM3,
          estimatedBillCents: TariffCalculator(_tariff).totalCents(monthM3),
          valve: m.valve,
          rssi: m.rssi,
          firmware: '1.2.0',
          budgetM3: _settings[account.id]?.budgetM3,
          tariff: _tariff,
          topAlert: unread.isEmpty ? null : unread.first,
        );
      });

  @override
  Stream<LiveReading> liveFlow(String meterId) async* {
    final m = _meter(meterId);
    yield m.tick();
    yield* Stream.periodic(const Duration(seconds: 2), (_) => m.tick());
  }

  @override
  Stream<ValveState> setValve(String meterId, {required bool open}) async* {
    final m = _meter(meterId);
    yield open ? ValveState.opening : ValveState.closing;
    // sent -> received -> executed, as the real command lifecycle would report.
    await Future.delayed(const Duration(milliseconds: 2200));
    if (!m.online) throw RepositoryException('The meter is offline. Try again when it reconnects.');
    m.valve = open ? ValveState.open : ValveState.closed;
    yield m.valve;
  }

  @override
  Future<UsageSeries> getUsage(String meterId, UsageRange range) => _delay(() {
        final m = _meter(meterId)..tick();
        final now = DateTime.now();
        final rnd = Random(m.seed + range.index);
        final points = <UsagePoint>[];
        double prev;
        switch (range) {
          case UsageRange.day:
            final start = DateTime(now.year, now.month, now.day);
            for (var h = 0; h <= now.hour; h++) {
              points.add(UsagePoint(start.add(Duration(hours: h)), _hourly(h, rnd)));
            }
            prev = List.generate(24, (h) => _hourly(h, rnd)).reduce((a, b) => a + b);
          case UsageRange.week:
            final start = DateTime(now.year, now.month, now.day).subtract(const Duration(days: 6));
            for (var d = 0; d < 7; d++) {
              points.add(UsagePoint(start.add(Duration(days: d)), _daily(rnd)));
            }
            prev = List.generate(7, (_) => _daily(rnd)).reduce((a, b) => a + b);
          case UsageRange.month:
            final start = DateTime(now.year, now.month, 1);
            final perDay = m.monthUsageLiters / max(1, now.day);
            for (var d = 0; d < now.day; d++) {
              final jitter = 0.6 + rnd.nextDouble() * 0.8;
              points.add(UsagePoint(start.add(Duration(days: d)), perDay * jitter));
            }
            final scale = m.monthUsageLiters / max(1, points.fold<double>(0, (s, p) => s + p.liters));
            for (var i = 0; i < points.length; i++) {
              points[i] = UsagePoint(points[i].start, points[i].liters * scale);
            }
            prev = 11800 + rnd.nextDouble() * 2400;
        }
        return UsageSeries(
          range: range,
          points: points,
          totalLiters: points.fold(0, (s, p) => s + p.liters),
          previousTotalLiters: prev,
        );
      });

  double _hourly(int hour, Random r) {
    // Morning and evening peaks, near zero overnight.
    const profile = [2, 1, 0, 0, 0, 4, 28, 45, 30, 14, 10, 12, 18, 14, 8, 8, 10, 22, 38, 34, 24, 14, 8, 4];
    return profile[hour] * (0.7 + r.nextDouble() * 0.6);
  }

  double _daily(Random r) => 330 + r.nextDouble() * 160;

  // ------------------------------------------------------------- billing

  @override
  Future<Tariff> getActiveTariff() => _delay(() => _tariff);

  List<Bill> _billsFor(String accountId) {
    final account = _account(accountId);
    final m = _meter(account.meterId);
    final calc = TariffCalculator(_tariff);
    final now = DateTime.now();
    final rnd = Random(m.seed);
    final bills = <Bill>[];
    var closing = m.monthStartLiters;
    for (var i = 1; i <= 6; i++) {
      final period = DateTime(now.year, now.month - i, 1);
      final usageL = 9000 + rnd.nextDouble() * 7000;
      final opening = max(0.0, closing - usageL);
      final lines = calc.billLines((closing - opening) / 1000);
      final total = lines.fold<int>(0, (s, l) => s + l.amountCents);
      // Older bills are settled; the latest one is paid once the customer pays it in the app.
      final paid = i > 1 || (_paidCents[accountId] ?? 0) >= total;
      bills.add(Bill(
        id: '$accountId-${period.year}-${period.month}',
        period: period,
        openingLiters: opening,
        closingLiters: closing,
        lines: lines,
        status: paid ? BillStatus.paid : BillStatus.published,
        dataBasis: i == 3 ? DataBasis.sdSynced : DataBasis.live,
        dueDate: DateTime(period.year, period.month + 1, 21),
        paidAt: !paid
            ? null
            : i > 1
                ? DateTime(period.year, period.month + 1, 15)
                : _lastPayment[accountId]?.at,
        readingDate: DateTime(period.year, period.month + 1, 0, 23, 59),
      ));
      closing = opening;
    }
    return bills;
  }

  @override
  Future<Balance> getBalance(String accountId) => _delay(() {
        final latest = _billsFor(accountId).first;
        final due = max(0, latest.totalCents - (_paidCents[accountId] ?? 0));
        final last = _lastPayment[accountId];
        return Balance(
          amountDueCents: due,
          lastPaymentCents: last?.cents ?? _billsFor(accountId)[1].totalCents,
          lastPaymentAt: last?.at ?? _billsFor(accountId)[1].paidAt,
          dueDate: latest.dueDate,
        );
      });

  @override
  Future<List<Bill>> getBills(String accountId) => _delay(() => _billsFor(accountId));

  @override
  Future<Bill> getCurrentEstimate(String accountId) => _delay(() {
        final account = _account(accountId);
        final m = _meter(account.meterId)..tick();
        final now = DateTime.now();
        return Bill(
          id: '$accountId-estimate',
          period: DateTime(now.year, now.month, 1),
          openingLiters: m.monthStartLiters,
          closingLiters: m.totalLiters,
          lines: TariffCalculator(_tariff).billLines(m.monthUsageLiters / 1000),
          status: BillStatus.estimate,
          dataBasis: DataBasis.live,
          readingDate: m.lastSeen,
        );
      });

  @override
  Future<PaymentResult> pay({required String accountId, required int amountCents}) async {
    await Future.delayed(const Duration(seconds: 2));
    if (amountCents <= 0) throw RepositoryException('Enter an amount greater than zero.');
    _paidCents[accountId] = (_paidCents[accountId] ?? 0) + amountCents;
    _lastPayment[accountId] = (cents: amountCents, at: DateTime.now());
    return PaymentResult(success: true, reference: 'PAY-${DateTime.now().millisecondsSinceEpoch % 1000000}');
  }

  // ------------------------------------------------ alerts/settings/support

  @override
  Future<List<AppAlert>> getAlerts() => _delay(() {
        final list = [..._alerts]..sort((a, b) => b.createdAt.compareTo(a.createdAt));
        return list;
      });

  @override
  Future<void> markAlertRead(String alertId) async {
    final i = _alerts.indexWhere((a) => a.id == alertId);
    if (i >= 0) _alerts[i] = _alerts[i].copyWith(read: true);
  }

  @override
  Future<AccountSettings> getSettings(String accountId) =>
      _delay(() => _settings[accountId] ?? const AccountSettings());

  @override
  Future<AccountSettings> saveSettings(String accountId, AccountSettings settings) =>
      _delay(() => _settings[accountId] = settings);

  @override
  Future<List<Ticket>> getTickets() => _delay(() => [..._tickets]..sort((a, b) => b.createdAt.compareTo(a.createdAt)));

  @override
  Future<Ticket> createTicket({required String category, required String subject, required String description}) =>
      _delay(() {
        final t = Ticket(
          id: 'TK-${1043 + _tickets.length}',
          category: category,
          subject: subject,
          description: description,
          status: TicketStatus.open,
          createdAt: DateTime.now(),
        );
        _tickets.add(t);
        return t;
      });

  // ------------------------------------------------------------- testing

  /// Raise a leak alert, as the backend leak rule would (used by the demo menu).
  void simulateLeak(String meterId) {
    _alerts.add(AppAlert(
      id: 'al-${_alerts.length + 1}',
      type: AlertType.leak,
      severity: AlertSeverity.critical,
      title: 'Possible leak detected',
      message: 'Water has been flowing continuously for over 3 hours at $meterId. '
          'Check taps and toilets, or close the valve.',
      createdAt: DateTime.now(),
      meterId: meterId,
    ));
  }
}

/// A fake ESP32 meter: produces realistic bursts of flow and keeps a cumulative total.
class _SimMeter {
  _SimMeter(this.id, double startLiters, this.seed)
      : totalLiters = startLiters,
        _rand = Random(seed) {
    final now = DateTime.now();
    final day = now.day - 1 + now.hour / 24;
    // Pretend the customer used ~400 L/day so far this month.
    monthStartLiters = max(0, startLiters - day * (380 + _rand.nextInt(80)));
    lastSeen = now;
  }

  final String id;
  final int seed;
  final Random _rand;
  double totalLiters;
  late final double monthStartLiters;
  late DateTime lastSeen;
  double flowLpm = 0;
  ValveState valve = ValveState.open;
  bool online = true;
  int rssi = -62;
  int _burstTicks = 0;

  double get monthUsageLiters => totalLiters - monthStartLiters;

  LiveReading tick() {
    final now = DateTime.now();
    final dt = now.difference(lastSeen).inMilliseconds / 60000.0; // minutes
    totalLiters += flowLpm * dt.clamp(0, 0.2);
    lastSeen = now;
    rssi = -58 - _rand.nextInt(14);

    if (valve != ValveState.open) {
      flowLpm = 0;
    } else if (_burstTicks > 0) {
      _burstTicks--;
      flowLpm = (flowLpm + (_rand.nextDouble() - 0.5) * 0.8).clamp(2.0, 12.0);
      if (_burstTicks == 0) flowLpm = 0;
    } else if (_rand.nextDouble() < 0.18) {
      _burstTicks = 3 + _rand.nextInt(8);
      flowLpm = 3 + _rand.nextDouble() * 6;
    }
    return LiveReading(flowLpm: flowLpm, totalLiters: totalLiters, at: now);
  }
}
