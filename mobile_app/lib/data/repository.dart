import 'models.dart';

/// Everything the app needs from the backend. Two implementations:
/// [MockWaterRepository] (simulated meter, default) and [ApiWaterRepository]
/// (Express REST API + Socket.IO, per PLAN_AND_ARCHITECTURE.md §7).
abstract class WaterRepository {
  // Auth
  Future<void> requestOtp(String identifier);
  Future<Customer> verifyOtp(String identifier, String code);
  Future<Customer?> restoreSession();
  Future<Customer> updateProfile({required String name, String? email, String? phone});
  Future<void> logout();

  // Accounts and meters
  Future<List<Account>> getAccounts();
  Future<Account> claimMeter({required String meterId, required String claimCode, required String label});
  Future<MeterSummary> getSummary(String meterId);

  /// Fast flow samples while the Home screen is visible. The implementation is
  /// responsible for starting/renewing live mode on the meter.
  Stream<LiveReading> liveFlow(String meterId);

  /// Sends a valve command and emits the lifecycle: closing/opening, then the
  /// confirmed state. Errors if the meter does not confirm in time.
  Stream<ValveState> setValve(String meterId, {required bool open});

  Future<UsageSeries> getUsage(String meterId, UsageRange range);

  // Billing
  Future<Tariff> getActiveTariff();
  Future<Balance> getBalance(String accountId);
  Future<List<Bill>> getBills(String accountId);
  Future<Bill> getCurrentEstimate(String accountId);
  Future<PaymentResult> pay({required String accountId, required int amountCents});

  // Alerts, settings, support
  Future<List<AppAlert>> getAlerts();
  Future<void> markAlertRead(String alertId);
  Future<AccountSettings> getSettings(String accountId);
  Future<AccountSettings> saveSettings(String accountId, AccountSettings settings);
  Future<List<Ticket>> getTickets();
  Future<Ticket> createTicket({required String category, required String subject, required String description});
}

class RepositoryException implements Exception {
  RepositoryException(this.message);

  final String message;

  @override
  String toString() => message;
}
