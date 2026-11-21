import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme.dart';
import '../../data/models.dart';
import '../../data/provisioning.dart';
import '../../state/providers.dart';
import '../../widgets/common.dart';

class WifiSetupScreen extends ConsumerStatefulWidget {
  const WifiSetupScreen({super.key, required this.account});

  final Account account;

  @override
  ConsumerState<WifiSetupScreen> createState() => _WifiSetupScreenState();
}

class _WifiSetupScreenState extends ConsumerState<WifiSetupScreen> {
  final _ssid = TextEditingController();
  final _password = TextEditingController();
  bool _obscure = true;
  ProvisionStep? _step;
  String? _error;
  StreamSubscription<ProvisionStep>? _sub;

  bool get _running => _step != null && _step != ProvisionStep.done && _error == null;

  @override
  void dispose() {
    _sub?.cancel();
    _ssid.dispose();
    _password.dispose();
    super.dispose();
  }

  void _start() {
    FocusScope.of(context).unfocus();
    setState(() {
      _error = null;
      _step = ProvisionStep.searching;
    });
    _sub?.cancel();
    _sub = ref
        .read(provisioningProvider)
        .provision(meterId: widget.account.meterId, ssid: _ssid.text, password: _password.text)
        .listen(
          (s) => setState(() => _step = s),
          onError:
              (Object e) => setState(() {
                _error = e is StateError ? e.message : e.toString();
                _step = null;
              }),
        );
  }

  @override
  Widget build(BuildContext context) {
    final service = ref.watch(provisioningProvider);
    final done = _step == ProvisionStep.done;
    return Scaffold(
      appBar: AppBar(title: const Text('Connect your meter')),
      body: PageBody(
        children: [
          const SizedBox(height: 8),
          Row(
            children: [
              const CircleAvatar(
                radius: 14,
                backgroundColor: AppColors.primary,
                child: Text('2', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
              ),
              const SizedBox(width: 10),
              const Text('Connect to Wi-Fi', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
              const Spacer(),
              Text('Meter ${widget.account.meterId}', style: const TextStyle(color: AppColors.textMuted)),
            ],
          ),
          const SizedBox(height: 16),
          AppCard(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.lightbulb_outline_rounded, color: AppColors.warning),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    service.needsCredentials
                        ? 'Hold the SETUP button on the meter for 5 seconds until the light blinks blue. '
                            'Keep your phone within a few metres of the meter. '
                            'The meter works with 2.4 GHz Wi-Fi only.'
                        : 'This meter joins Wi-Fi with the network details set in its firmware. '
                            'Power it on, then tap "Check connection". When the meter screen shows ONLINE, '
                            'the app will confirm it here. The meter works with 2.4 GHz Wi-Fi only.',
                    style: const TextStyle(height: 1.4),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          if (service.needsCredentials) ...[
            TextField(
              controller: _ssid,
              enabled: !_running && !done,
              decoration: const InputDecoration(labelText: 'Wi-Fi network name', prefixIcon: Icon(Icons.wifi)),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _password,
              enabled: !_running && !done,
              obscureText: _obscure,
              decoration: InputDecoration(
                labelText: 'Wi-Fi password',
                prefixIcon: const Icon(Icons.lock_outline),
                suffixIcon: IconButton(
                  icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                  onPressed: () => setState(() => _obscure = !_obscure),
                ),
              ),
            ),
            const SizedBox(height: 20),
          ],
          if (_step != null || _error != null) ...[
            AppCard(
              child: Column(
                children: [
                  for (final s in service.steps) _StepRow(step: s, current: _step),
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Row(
                        children: [
                          const Icon(Icons.error_outline, color: AppColors.danger),
                          const SizedBox(width: 8),
                          Expanded(child: Text(_error!, style: const TextStyle(color: AppColors.danger))),
                        ],
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 20),
          ],
          if (done)
            FilledButton(onPressed: () => context.go('/home'), child: const Text('Go to my dashboard'))
          else
            FilledButton(
              onPressed: _running ? null : _start,
              child: Text(
                _error != null ? 'Try again' : (service.needsCredentials ? 'Connect meter' : 'Check connection'),
              ),
            ),
          const SizedBox(height: 8),
          if (!done)
            TextButton(onPressed: _running ? null : () => context.go('/home'), child: const Text('Do this later')),
        ],
      ),
    );
  }
}

class _StepRow extends StatelessWidget {
  const _StepRow({required this.step, required this.current});

  final ProvisionStep step;
  final ProvisionStep? current;

  @override
  Widget build(BuildContext context) {
    final idx = current?.index ?? -1;
    final complete = step.index < idx || current == ProvisionStep.done;
    final active = step.index == idx && current != ProvisionStep.done;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          SizedBox(
            width: 24,
            height: 24,
            child:
                complete
                    ? const Icon(Icons.check_circle_rounded, color: AppColors.success)
                    : active
                    ? const Padding(padding: EdgeInsets.all(3), child: CircularProgressIndicator(strokeWidth: 2.5))
                    : const Icon(Icons.radio_button_unchecked, color: AppColors.border),
          ),
          const SizedBox(width: 12),
          Text(
            step.label,
            style: TextStyle(
              color: complete || active ? AppColors.text : AppColors.textMuted,
              fontWeight: active ? FontWeight.w700 : FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }
}
