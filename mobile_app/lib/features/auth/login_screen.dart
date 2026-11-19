import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/config.dart';
import '../../core/theme.dart';
import '../../state/providers.dart';
import '../../widgets/common.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _controller = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final id = _controller.text.trim();
    if (id.isEmpty) return;
    setState(() => _busy = true);
    try {
      await ref.read(authProvider.notifier).requestOtp(id);
      if (mounted) context.push('/otp', extra: id);
    } catch (e) {
      if (mounted) showMessage(context, e.toString(), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Icon(Icons.water_drop_rounded, size: 64, color: AppColors.water),
                  const SizedBox(height: 16),
                  const Text(
                    'Smart Water',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'See your water use live, control your supply and pay your bills.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AppColors.textMuted, fontSize: 15),
                  ),
                  const SizedBox(height: 36),
                  TextField(
                    controller: _controller,
                    keyboardType: TextInputType.emailAddress,
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) => _submit(),
                    decoration: const InputDecoration(
                      labelText: 'Mobile number or email',
                      hintText: '07X XXX XXXX',
                      prefixIcon: Icon(Icons.person_outline),
                    ),
                  ),
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed: _busy ? null : _submit,
                    child: _busy
                        ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                        : const Text('Send code'),
                  ),
                  const SizedBox(height: 16),
                  const Text(
                    'We will send a one-time code to sign you in. New users get an account automatically.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AppColors.textMuted, fontSize: 13),
                  ),
                  if (AppConfig.useMock) ...[
                    const SizedBox(height: 24),
                    const StatusPill(
                      label: 'Demo mode: any number works, code ${AppConfig.mockOtp}',
                      color: AppColors.warning,
                      icon: Icons.science_outlined,
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
