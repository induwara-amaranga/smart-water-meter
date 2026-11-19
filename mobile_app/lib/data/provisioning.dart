import 'dart:async';

/// Steps of the "Connect your meter" Wi-Fi wizard (design doc §3, Wi-Fi setup).
enum ProvisionStep { searching, connecting, sendingCredentials, waitingForCloud, done }

extension ProvisionStepText on ProvisionStep {
  String get label => switch (this) {
        ProvisionStep.searching => 'Looking for your meter nearby',
        ProvisionStep.connecting => 'Connecting to the meter',
        ProvisionStep.sendingCredentials => 'Sending Wi-Fi details',
        ProvisionStep.waitingForCloud => 'Waiting for the meter to come online',
        ProvisionStep.done => 'Meter connected',
      };
}

/// Hands home Wi-Fi credentials to a meter in setup mode.
///
/// The production implementation should use Espressif's unified provisioning
/// over BLE (ESP32-S3), with SoftAP (phone joins the meter hotspot and POSTs to
/// 192.168.4.1) as the fallback. Both depend on the firmware's setup mode, so
/// only the simulated version exists until that firmware is ready.
abstract class ProvisioningService {
  Stream<ProvisionStep> provision({required String meterId, required String ssid, required String password});
}

class MockProvisioningService implements ProvisioningService {
  @override
  Stream<ProvisionStep> provision({required String meterId, required String ssid, required String password}) async* {
    if (ssid.trim().isEmpty) throw StateError('Enter your Wi-Fi network name');
    if (password.isNotEmpty && password.length < 8) {
      throw StateError('Wi-Fi passwords are at least 8 characters');
    }
    for (final step in ProvisionStep.values) {
      yield step;
      if (step != ProvisionStep.done) {
        await Future.delayed(Duration(milliseconds: step == ProvisionStep.waitingForCloud ? 2500 : 1200));
      }
    }
  }
}
