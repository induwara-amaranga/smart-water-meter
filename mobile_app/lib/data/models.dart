// Domain models shared by the mock and API repositories.
// Money is integer cents (Rs. 1 = 100), volumes are litres unless named *M3.

DateTime _date(dynamic v) => DateTime.parse(v as String).toLocal();
DateTime? _dateOrNull(dynamic v) => v == null ? null : _date(v);
double _d(dynamic v) => (v as num).toDouble();

T _enum<T extends Enum>(List<T> values, dynamic name, T fallback) {
  for (final v in values) {
    if (v.name.toLowerCase() == (name as String?)?.toLowerCase().replaceAll('_', '')) return v;
  }
  return fallback;
}

class Customer {
  const Customer({required this.id, required this.name, this.phone, this.email});

  final String id;
  final String name;
  final String? phone;
  final String? email;

  factory Customer.fromJson(Map<String, dynamic> j) => Customer(
        id: j['id'] as String,
        name: j['name'] as String? ?? '',
        phone: j['phone'] as String?,
        email: j['email'] as String?,
      );

  Customer copyWith({String? name, String? phone, String? email}) =>
      Customer(id: id, name: name ?? this.name, phone: phone ?? this.phone, email: email ?? this.email);
}

class Account {
  const Account({
    required this.id,
    required this.accountNo,
    required this.label,
    required this.address,
    required this.meterId,
    required this.holderName,
  });

  final String id;
  final String accountNo;

  /// Short name shown in the account switcher, e.g. "Home" or "Kotte".
  final String label;
  final String address;
  final String meterId;
  final String holderName;

  factory Account.fromJson(Map<String, dynamic> j) => Account(
        id: j['id'] as String,
        accountNo: j['accountNo'] as String,
        label: j['label'] as String? ?? j['accountNo'] as String,
        address: j['address'] as String? ?? '',
        meterId: j['meterId'] as String,
        holderName: j['holderName'] as String? ?? '',
      );
}

class TariffSlab {
  const TariffSlab({required this.upToM3, required this.rateCents});

  /// Upper bound of this slab in cumulative m³; null means no upper bound.
  final double? upToM3;
  final int rateCents;

  factory TariffSlab.fromJson(Map<String, dynamic> j) => TariffSlab(
        upToM3: j['upToM3'] == null ? null : _d(j['upToM3']),
        rateCents: j['rateCents'] as int,
      );
}

class Tariff {
  const Tariff({
    required this.name,
    required this.slabs,
    required this.serviceChargeCents,
    required this.effectiveFrom,
  });

  final String name;
  final List<TariffSlab> slabs;
  final int serviceChargeCents;
  final DateTime effectiveFrom;

  factory Tariff.fromJson(Map<String, dynamic> j) => Tariff(
        name: j['name'] as String,
        slabs: (j['slabs'] as List).map((e) => TariffSlab.fromJson(e as Map<String, dynamic>)).toList(),
        serviceChargeCents: j['serviceChargeCents'] as int,
        effectiveFrom: _date(j['effectiveFrom']),
      );
}

enum ValveState { open, closed, opening, closing, unknown }

class LiveReading {
  const LiveReading({required this.flowLpm, required this.totalLiters, required this.at});

  final double flowLpm;
  final double totalLiters;
  final DateTime at;

  factory LiveReading.fromJson(Map<String, dynamic> j) => LiveReading(
        flowLpm: _d(j['flowLpm']),
        totalLiters: _d(j['totalL']),
        at: j['ts'] is num
            ? DateTime.fromMillisecondsSinceEpoch((j['ts'] as num).toInt() * 1000)
            : DateTime.now(),
      );
}

class MeterSummary {
  const MeterSummary({
    required this.meterId,
    required this.online,
    required this.lastSeen,
    required this.flowLpm,
    required this.totalLiters,
    required this.monthUsageM3,
    required this.estimatedBillCents,
    required this.valve,
    required this.rssi,
    required this.firmware,
    required this.budgetM3,
    required this.tariff,
    this.topAlert,
  });

  final String meterId;
  final bool online;
  final DateTime lastSeen;
  final double flowLpm;
  final double totalLiters;
  final double monthUsageM3;
  final int estimatedBillCents;
  final ValveState valve;
  final int rssi;
  final String firmware;
  final double? budgetM3;
  final Tariff tariff;
  final AppAlert? topAlert;

  factory MeterSummary.fromJson(Map<String, dynamic> j) => MeterSummary(
        meterId: j['meterId'] as String,
        online: j['online'] as bool,
        lastSeen: _date(j['lastSeenAt']),
        flowLpm: _d(j['flowLpm'] ?? 0),
        totalLiters: _d(j['totalL']),
        monthUsageM3: _d(j['monthUsageM3']),
        estimatedBillCents: j['estimatedBillCents'] as int,
        valve: _enum(ValveState.values, j['valve'], ValveState.unknown),
        rssi: j['rssi'] as int? ?? 0,
        firmware: j['fw'] as String? ?? '',
        budgetM3: j['budgetM3'] == null ? null : _d(j['budgetM3']),
        tariff: Tariff.fromJson(j['tariff'] as Map<String, dynamic>),
        topAlert: j['topAlert'] == null ? null : AppAlert.fromJson(j['topAlert'] as Map<String, dynamic>),
      );
}

enum UsageRange { day, week, month }

class UsagePoint {
  const UsagePoint(this.start, this.liters);

  final DateTime start;
  final double liters;

  factory UsagePoint.fromJson(Map<String, dynamic> j) => UsagePoint(_date(j['start']), _d(j['liters']));
}

class UsageSeries {
  const UsageSeries({
    required this.range,
    required this.points,
    required this.totalLiters,
    required this.previousTotalLiters,
  });

  final UsageRange range;
  final List<UsagePoint> points;
  final double totalLiters;

  /// Total of the previous equivalent period (yesterday, last week, last month).
  final double previousTotalLiters;

  factory UsageSeries.fromJson(UsageRange range, Map<String, dynamic> j) => UsageSeries(
        range: range,
        points: (j['points'] as List).map((e) => UsagePoint.fromJson(e as Map<String, dynamic>)).toList(),
        totalLiters: _d(j['totalLiters']),
        previousTotalLiters: _d(j['previousTotalLiters']),
      );
}

enum BillLineKind { tier, service, arrears, penalty, adjustment }

class BillLine {
  const BillLine({
    required this.kind,
    required this.description,
    required this.amountCents,
    this.qtyM3,
    this.rateCents,
  });

  final BillLineKind kind;
  final String description;
  final double? qtyM3;
  final int? rateCents;
  final int amountCents;

  factory BillLine.fromJson(Map<String, dynamic> j) => BillLine(
        kind: _enum(BillLineKind.values, j['kind'], BillLineKind.adjustment),
        description: j['description'] as String,
        qtyM3: j['qtyM3'] == null ? null : _d(j['qtyM3']),
        rateCents: j['rateCents'] as int?,
        amountCents: j['amountCents'] as int,
      );
}

enum BillStatus { estimate, published, paid, overdue }

/// Where the readings behind a bill came from (design doc §3, offline billing).
enum DataBasis { live, sdSynced, estimated }

class Bill {
  const Bill({
    required this.id,
    required this.period,
    required this.openingLiters,
    required this.closingLiters,
    required this.lines,
    required this.status,
    required this.dataBasis,
    this.dueDate,
    this.paidAt,
    this.readingDate,
  });

  final String id;

  /// First day of the billed month.
  final DateTime period;
  final double openingLiters;
  final double closingLiters;
  final List<BillLine> lines;
  final BillStatus status;
  final DataBasis dataBasis;
  final DateTime? dueDate;
  final DateTime? paidAt;
  final DateTime? readingDate;

  double get usageM3 => (closingLiters - openingLiters) / 1000;
  int get totalCents => lines.fold(0, (sum, l) => sum + l.amountCents);
  int get usageChargeCents =>
      lines.where((l) => l.kind == BillLineKind.tier).fold(0, (sum, l) => sum + l.amountCents);
  int get currentMonthCents => lines
      .where((l) => l.kind == BillLineKind.tier || l.kind == BillLineKind.service)
      .fold(0, (sum, l) => sum + l.amountCents);

  factory Bill.fromJson(Map<String, dynamic> j) => Bill(
        id: j['id'] as String,
        period: _date(j['period']),
        openingLiters: _d(j['openingL']),
        closingLiters: _d(j['closingL']),
        lines: (j['lines'] as List).map((e) => BillLine.fromJson(e as Map<String, dynamic>)).toList(),
        status: _enum(BillStatus.values, j['status'], BillStatus.published),
        dataBasis: _enum(DataBasis.values, j['dataBasis'], DataBasis.live),
        dueDate: _dateOrNull(j['dueDate']),
        paidAt: _dateOrNull(j['paidAt']),
        readingDate: _dateOrNull(j['readingDate']),
      );
}

class Balance {
  const Balance({required this.amountDueCents, this.lastPaymentCents, this.lastPaymentAt, this.dueDate});

  final int amountDueCents;
  final int? lastPaymentCents;
  final DateTime? lastPaymentAt;
  final DateTime? dueDate;

  factory Balance.fromJson(Map<String, dynamic> j) => Balance(
        amountDueCents: j['amountDueCents'] as int,
        lastPaymentCents: j['lastPaymentCents'] as int?,
        lastPaymentAt: _dateOrNull(j['lastPaymentAt']),
        dueDate: _dateOrNull(j['dueDate']),
      );
}

enum AlertType { leak, highUsage, budget, device, billing, notice }

enum AlertSeverity { info, warning, critical }

class AppAlert {
  const AppAlert({
    required this.id,
    required this.type,
    required this.severity,
    required this.title,
    required this.message,
    required this.createdAt,
    this.read = false,
    this.meterId,
  });

  final String id;
  final AlertType type;
  final AlertSeverity severity;
  final String title;
  final String message;
  final DateTime createdAt;
  final bool read;
  final String? meterId;

  AppAlert copyWith({bool? read}) => AppAlert(
        id: id,
        type: type,
        severity: severity,
        title: title,
        message: message,
        createdAt: createdAt,
        read: read ?? this.read,
        meterId: meterId,
      );

  factory AppAlert.fromJson(Map<String, dynamic> j) => AppAlert(
        id: j['id'] as String,
        type: _enum(AlertType.values, j['type'], AlertType.notice),
        severity: _enum(AlertSeverity.values, j['severity'], AlertSeverity.info),
        title: j['title'] as String,
        message: j['message'] as String? ?? '',
        createdAt: _date(j['createdAt']),
        read: j['read'] as bool? ?? false,
        meterId: j['meterId'] as String?,
      );
}

class AccountSettings {
  const AccountSettings({
    this.budgetM3,
    this.leakAlerts = true,
    this.usageAlerts = true,
    this.billAlerts = true,
    this.awayMode = false,
    this.emergencyContact,
  });

  final double? budgetM3;
  final bool leakAlerts;
  final bool usageAlerts;
  final bool billAlerts;

  /// Flume-style Away Mode: any flow raises an alert and notifies the emergency contact.
  final bool awayMode;
  final String? emergencyContact;

  AccountSettings copyWith({
    double? budgetM3,
    bool clearBudget = false,
    bool? leakAlerts,
    bool? usageAlerts,
    bool? billAlerts,
    bool? awayMode,
    String? emergencyContact,
  }) =>
      AccountSettings(
        budgetM3: clearBudget ? null : (budgetM3 ?? this.budgetM3),
        leakAlerts: leakAlerts ?? this.leakAlerts,
        usageAlerts: usageAlerts ?? this.usageAlerts,
        billAlerts: billAlerts ?? this.billAlerts,
        awayMode: awayMode ?? this.awayMode,
        emergencyContact: emergencyContact ?? this.emergencyContact,
      );

  Map<String, dynamic> toJson() => {
        'budgetM3': budgetM3,
        'leakAlerts': leakAlerts,
        'usageAlerts': usageAlerts,
        'billAlerts': billAlerts,
        'awayMode': awayMode,
        'emergencyContact': emergencyContact,
      };

  factory AccountSettings.fromJson(Map<String, dynamic> j) => AccountSettings(
        budgetM3: j['budgetM3'] == null ? null : _d(j['budgetM3']),
        leakAlerts: j['leakAlerts'] as bool? ?? true,
        usageAlerts: j['usageAlerts'] as bool? ?? true,
        billAlerts: j['billAlerts'] as bool? ?? true,
        awayMode: j['awayMode'] as bool? ?? false,
        emergencyContact: j['emergencyContact'] as String?,
      );
}

enum TicketStatus { open, inProgress, resolved, closed }

class Ticket {
  const Ticket({
    required this.id,
    required this.category,
    required this.subject,
    required this.description,
    required this.status,
    required this.createdAt,
  });

  final String id;
  final String category;
  final String subject;
  final String description;
  final TicketStatus status;
  final DateTime createdAt;

  factory Ticket.fromJson(Map<String, dynamic> j) => Ticket(
        id: j['id'] as String,
        category: j['category'] as String,
        subject: j['subject'] as String,
        description: j['description'] as String? ?? '',
        status: _enum(TicketStatus.values, j['status'], TicketStatus.open),
        createdAt: _date(j['createdAt']),
      );
}

class PaymentResult {
  const PaymentResult({required this.success, required this.reference, this.message});

  final bool success;
  final String reference;
  final String? message;
}
