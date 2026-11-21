import 'dart:async';

import 'repository.dart';

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

/// Gets a meter onto the home Wi-Fi and confirms it reached the backend.
///
/// The production implementation should use Espressif's unified provisioning
/// over BLE (ESP32-S3), with SoftAP (phone joins the meter hotspot and POSTs to
/// 192.168.4.1) as the fallback. Both depend on a firmware setup mode that does
/// not exist yet, so today the Wi-Fi details are compiled into the firmware
/// (config.h) and [CloudCheckProvisioningService] only confirms the meter is online.
abstract class ProvisioningService {
  /// The steps this implementation goes through, in order (shown as a checklist).
  List<ProvisionStep> get steps;

  /// Whether the user must type the Wi-Fi name and password into the app.
  bool get needsCredentials;

  Stream<ProvisionStep> provision({required String meterId, required String ssid, required String password});
}

/// Demo mode: animates the full wizard without talking to anything.
class MockProvisioningService implements ProvisioningService {
  @override
  List<ProvisionStep> get steps => ProvisionStep.values;

  @override
  bool get needsCredentials => true;

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

/// Real backend: the meter joins Wi-Fi using the details in its firmware
/// (config.h). This polls the backend until the meter reports online over MQTT.
class CloudCheckProvisioningService implements ProvisioningService {
  CloudCheckProvisioningService(
    this._repo, {
    this.pollEvery = const Duration(seconds: 3),
    this.timeout = const Duration(minutes: 3),
  });

  final WaterRepository _repo;
  final Duration pollEvery;
  final Duration timeout;

  @override
  List<ProvisionStep> get steps => const [ProvisionStep.waitingForCloud, ProvisionStep.done];

  @override
  bool get needsCredentials => false;

  @override
  Stream<ProvisionStep> provision({required String meterId, required String ssid, required String password}) async* {
    yield ProvisionStep.waitingForCloud;
    final deadline = DateTime.now().add(timeout);
    String? lastError;
    while (DateTime.now().isBefore(deadline)) {
      try {
        final summary = await _repo.getSummary(meterId);
        if (summary.online) {
          yield ProvisionStep.done;
          return;
        }
        lastError = null;
      } on RepositoryException catch (e) {
        lastError = e.message; // e.g. backend briefly unreachable: keep trying
      }
      await Future.delayed(pollEvery);
    }
    throw StateError(
      lastError != null
          ? 'Could not reach the server: $lastError'
          : 'Meter $meterId has not come online yet. Check that it is powered, that its Wi-Fi '
              'details and server address (config.h) are right, then try again.',
    );
  }
}
