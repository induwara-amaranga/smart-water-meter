import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../core/config.dart';
import '../../core/theme.dart';
import '../../state/providers.dart';
import '../../widgets/common.dart';

/// Link a meter to the customer's account with its ID and the claim code
/// printed on the meter (or its QR code), then continue to Wi-Fi setup.
///
/// QR format: `swm://claim?meter=SWM-000789&code=ABCD-1234`
class AddMeterScreen extends ConsumerStatefulWidget {
  const AddMeterScreen({super.key});

  @override
  ConsumerState<AddMeterScreen> createState() => _AddMeterScreenState();
}

class _AddMeterScreenState extends ConsumerState<AddMeterScreen> {
  final _formKey = GlobalKey<FormState>();
  final _meterId = TextEditingController();
  final _code = TextEditingController();
  final _label = TextEditingController(text: 'Home');
  bool _busy = false;

  @override
  void dispose() {
    _meterId.dispose();
    _code.dispose();
    _label.dispose();
    super.dispose();
  }

  Future<void> _scan() async {
    final raw = await Navigator.of(context).push<String>(
      MaterialPageRoute(fullscreenDialog: true, builder: (_) => const _QrScanPage()),
    );
    if (raw == null) return;
    final uri = Uri.tryParse(raw);
    final meter = uri?.queryParameters['meter'];
    final code = uri?.queryParameters['code'];
    if (uri?.scheme != 'swm' || meter == null || code == null) {
      if (mounted) showMessage(context, 'This QR code is not a Smart Water meter code.', error: true);
      return;
    }
    setState(() {
      _meterId.text = meter;
      _code.text = code;
    });
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _busy = true);
    try {
      final account = await ref.read(repositoryProvider).claimMeter(
            meterId: _meterId.text,
            claimCode: _code.text,
            label: _label.text,
          );
      ref.invalidate(accountsProvider);
      ref.read(selectedAccountIdProvider.notifier).select(account.id);
      if (mounted) context.pushReplacement('/add-meter/wifi', extra: account);
    } catch (e) {
      if (mounted) showMessage(context, e.toString(), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Add meter')),
      body: Form(
        key: _formKey,
        child: PageBody(
          children: [
            const SizedBox(height: 8),
            const _StepHeader(step: 1, title: 'Find your meter code'),
            const SizedBox(height: 8),
            const Text(
              'The meter ID and claim code are on the label on your meter. '
              'Scanning the QR code fills them in for you.',
              style: TextStyle(color: AppColors.textMuted),
            ),
            const SizedBox(height: 16),
            OutlinedButton.icon(
              onPressed: _scan,
              icon: const Icon(Icons.qr_code_scanner_rounded),
              label: const Text('Scan QR code'),
            ),
            const SizedBox(height: 20),
            const Row(children: [
              Expanded(child: Divider()),
              Padding(
                padding: EdgeInsets.symmetric(horizontal: 12),
                child: Text('or type it in', style: TextStyle(color: AppColors.textMuted)),
              ),
              Expanded(child: Divider()),
            ]),
            const SizedBox(height: 20),
            TextFormField(
              controller: _meterId,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(labelText: 'Meter ID', hintText: 'SWM-000123'),
              validator: (v) => (v ?? '').trim().length < 5 ? 'Enter the meter ID' : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _code,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(labelText: 'Claim code', hintText: 'ABCD-1234'),
              validator: (v) => (v ?? '').trim().length < 4 ? 'Enter the claim code' : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _label,
              decoration: const InputDecoration(labelText: 'Name this meter', hintText: 'Home, Shop, Parents…'),
            ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: _busy ? null : _submit,
              child: _busy
                  ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                  : const Text('Continue to Wi-Fi setup'),
            ),
            if (AppConfig.useMock) ...[
              const SizedBox(height: 20),
              const Center(
                child: StatusPill(
                  label: 'Demo meter: SWM-000789 / ABCD-1234',
                  color: AppColors.warning,
                  icon: Icons.science_outlined,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _StepHeader extends StatelessWidget {
  const _StepHeader({required this.step, required this.title});

  final int step;
  final String title;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        CircleAvatar(
          radius: 14,
          backgroundColor: AppColors.primary,
          child: Text('$step', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
        ),
        const SizedBox(width: 10),
        Text(title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
        const Spacer(),
        Text('Step $step of 2', style: const TextStyle(color: AppColors.textMuted)),
      ],
    );
  }
}

class _QrScanPage extends StatefulWidget {
  const _QrScanPage();

  @override
  State<_QrScanPage> createState() => _QrScanPageState();
}

class _QrScanPageState extends State<_QrScanPage> {
  bool _done = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan meter QR code')),
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(
            onDetect: (capture) {
              final value = capture.barcodes.firstOrNull?.rawValue;
              if (value == null || _done) return;
              _done = true;
              Navigator.of(context).pop(value);
            },
          ),
          Center(
            child: Container(
              width: 240,
              height: 240,
              decoration: BoxDecoration(
                border: Border.all(color: AppColors.water, width: 3),
                borderRadius: BorderRadius.circular(20),
              ),
            ),
          ),
          const Positioned(
            left: 0,
            right: 0,
            bottom: 48,
            child: Text(
              'Point the camera at the QR code on the meter label',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 15, shadows: [Shadow(blurRadius: 6)]),
            ),
          ),
        ],
      ),
    );
  }
}
