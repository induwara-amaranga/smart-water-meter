/// Build-time configuration. Override with --dart-define, for example:
///
///   flutter run --dart-define=USE_MOCK=false \
///               --dart-define=API_BASE_URL=https://api.example.com/api/v1 \
///               --dart-define=SOCKET_URL=https://api.example.com
class AppConfig {
  /// When true the app runs against an in-memory simulated meter and backend.
  static const bool useMock = bool.fromEnvironment('USE_MOCK', defaultValue: true);

  /// REST base URL. 10.0.2.2 is the host machine as seen from the Android emulator.
  static const String apiBaseUrl =
      String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:3000/api/v1');

  /// Socket.IO server for live flow, valve and alert events.
  static const String socketUrl =
      String.fromEnvironment('SOCKET_URL', defaultValue: 'http://10.0.2.2:3000');

  /// OTP accepted by the mock backend.
  static const String mockOtp = '123456';

  /// How long the app waits for a valve confirmation before showing a failure.
  static const Duration valveTimeout = Duration(seconds: 60);
}
