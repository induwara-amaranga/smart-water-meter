import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme.dart';
import '../../state/providers.dart';
import '../../widgets/common.dart';

class OtpScreen extends ConsumerStatefulWidget {
  const OtpScreen({super.key, required this.identifier});

  final String identifier;

  @override
  ConsumerState<OtpScreen> createState() => _OtpScreenState();
}

class _OtpScreenState extends ConsumerState<OtpScreen> {
  final _controller = TextEditingController();
  bool _busy = false;
  int _resendIn = 30;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _startTimer();
  }

  void _startTimer() {
    _timer?.cancel();
    setState(() => _resendIn = 30);
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (_resendIn <= 1) t.cancel();
      setState(() => _resendIn--);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  Future<void> _verify() async {
    if (_controller.text.length != 6 || _busy) return;
    setState(() => _busy = true);
    try {
      // On success the router redirect moves the user to /home.
      await ref.read(authProvider.notifier).verifyOtp(widget.identifier, _controller.text);
    } catch (e) {
      if (mounted) {
        showMessage(context, e.toString(), error: true);
        _controller.clear();
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resend() async {
    try {
      await ref.read(authProvider.notifier).requestOtp(widget.identifier);
      _startTimer();
      if (mounted) showMessage(context, 'A new code has been sent.');
    } catch (e) {
      if (mounted) showMessage(context, e.toString(), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(backgroundColor: Colors.transparent),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Icon(Icons.sms_outlined, size: 56, color: AppColors.primary),
                  const SizedBox(height: 16),
                  const Text('Enter the code',
                      textAlign: TextAlign.center, style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 8),
                  Text('We sent a 6-digit code to ${widget.identifier}',
                      textAlign: TextAlign.center, style: const TextStyle(color: AppColors.textMuted)),
                  const SizedBox(height: 28),
                  TextField(
                    controller: _controller,
                    autofocus: true,
                    keyboardType: TextInputType.number,
                    textAlign: TextAlign.center,
                    maxLength: 6,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    style: const TextStyle(fontSize: 30, letterSpacing: 14, fontWeight: FontWeight.w700),
                    decoration: const InputDecoration(counterText: '', hintText: '••••••'),
                    onChanged: (v) {
                      if (v.length == 6) _verify();
                    },
                  ),
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed: _busy ? null : _verify,
                    child: _busy
                        ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                        : const Text('Verify'),
                  ),
                  const SizedBox(height: 8),
                  TextButton(
                    onPressed: _resendIn > 0 ? null : _resend,
                    child: Text(_resendIn > 0 ? 'Resend code in $_resendIn s' : 'Resend code'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
