import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../core/theme.dart';
import '../../state/providers.dart';
import '../../widgets/common.dart';

/// Payment screen. Uses the gateway sandbox / mock checkout; real money handling
/// is out of scope for the project (design doc §8).
class PayScreen extends ConsumerStatefulWidget {
  const PayScreen({super.key, this.suggestedCents});

  final int? suggestedCents;

  @override
  ConsumerState<PayScreen> createState() => _PayScreenState();
}

class _PayScreenState extends ConsumerState<PayScreen> {
  final _amount = TextEditingController();
  String _method = 'card';
  bool _busy = false;
  bool _prefilled = false;

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  void _prefill(int cents) {
    if (_prefilled) return;
    _prefilled = true;
    _amount.text = (cents / 100).toStringAsFixed(2);
  }

  Future<void> _pay(String accountId) async {
    final cents = ((double.tryParse(_amount.text.replaceAll(',', '')) ?? 0) * 100).round();
    if (cents <= 0) {
      showMessage(context, 'Enter an amount to pay.', error: true);
      return;
    }
    setState(() => _busy = true);
    try {
      final result = await ref.read(repositoryProvider).pay(accountId: accountId, amountCents: cents);
      ref.invalidate(balanceProvider(accountId));
      ref.invalidate(billsProvider(accountId));
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          backgroundColor: AppColors.surfaceHigh,
          icon: Icon(
            result.success ? Icons.check_circle_rounded : Icons.error_rounded,
            color: result.success ? AppColors.success : AppColors.danger,
            size: 48,
          ),
          title: Text(result.success ? 'Payment successful' : 'Payment failed'),
          content: Text(
            result.success
                ? '${formatMoney(cents)} paid.\nReference: ${result.reference}'
                : result.message ?? 'Please try again.',
            textAlign: TextAlign.center,
          ),
          actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Done'))],
        ),
      );
      if (mounted && result.success) context.pop();
    } catch (e) {
      if (mounted) showMessage(context, e.toString(), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final account = ref.watch(currentAccountProvider);
    if (account == null) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    final balance = ref.watch(balanceProvider(account.id));
    final due = widget.suggestedCents ?? balance.value?.amountDueCents;
    if (due != null) _prefill(due);

    return Scaffold(
      appBar: AppBar(title: const Text('Pay now')),
      body: PageBody(
        children: [
          const SizedBox(height: 8),
          AppCard(
            color: AppColors.surfaceHigh,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Account number', style: TextStyle(color: AppColors.textMuted)),
                Text(account.accountNo, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                const SizedBox(height: 14),
                const Text('Amount due', style: TextStyle(color: AppColors.textMuted)),
                Text(
                  balance.value == null ? '—' : formatMoney(balance.value!.amountDueCents),
                  style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w900),
                ),
              ],
            ),
          ),
          const SectionTitle('Payment method'),
          _MethodTile(
            selected: _method == 'card',
            icon: Icons.credit_card,
            label: 'Visa / Mastercard',
            onTap: () => setState(() => _method = 'card'),
          ),
          const SizedBox(height: 10),
          _MethodTile(
            selected: _method == 'wallet',
            icon: Icons.account_balance_wallet_outlined,
            label: 'Mobile wallet',
            onTap: () => setState(() => _method = 'wallet'),
          ),
          const SectionTitle('Amount'),
          TextField(
            controller: _amount,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]'))],
            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
            decoration: const InputDecoration(prefixText: 'Rs.  '),
          ),
          const SizedBox(height: 24),
          FilledButton(
            onPressed: _busy ? null : () => _pay(account.id),
            child: _busy
                ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                : const Text('Proceed to payment'),
          ),
          const SizedBox(height: 12),
          const Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.lock_outline, size: 16, color: AppColors.textMuted),
              SizedBox(width: 6),
              Text('Test payments only (sandbox)', style: TextStyle(color: AppColors.textMuted, fontSize: 13)),
            ],
          ),
        ],
      ),
    );
  }
}

class _MethodTile extends StatelessWidget {
  const _MethodTile({required this.selected, required this.icon, required this.label, required this.onTap});

  final bool selected;
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? AppColors.primary.withValues(alpha: 0.12) : AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: selected ? AppColors.primary : AppColors.border, width: selected ? 1.5 : 1),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Row(
            children: [
              Icon(icon, color: selected ? AppColors.primary : AppColors.textMuted),
              const SizedBox(width: 14),
              Expanded(
                child: Text(label,
                    style: TextStyle(
                      fontWeight: FontWeight.w700,
                      color: selected ? AppColors.primary : AppColors.text,
                    )),
              ),
              Icon(selected ? Icons.radio_button_checked : Icons.radio_button_off,
                  color: selected ? AppColors.primary : AppColors.textMuted),
            ],
          ),
        ),
      ),
    );
  }
}
