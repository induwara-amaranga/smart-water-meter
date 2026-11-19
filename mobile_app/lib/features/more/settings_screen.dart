import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme.dart';
import '../../data/models.dart';
import '../../state/providers.dart';
import '../../widgets/common.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final account = ref.watch(currentAccountProvider);
    return Scaffold(
      appBar: AppBar(title: Text('Budget & alerts${account == null ? '' : ' · ${account.label}'}')),
      body: account == null
          ? const SizedBox.shrink()
          : AsyncView(
              value: ref.watch(settingsProvider(account.id)),
              onRetry: () => ref.invalidate(settingsProvider(account.id)),
              data: (s) => _SettingsForm(accountId: account.id, initial: s),
            ),
    );
  }
}

class _SettingsForm extends ConsumerStatefulWidget {
  const _SettingsForm({required this.accountId, required this.initial});

  final String accountId;
  final AccountSettings initial;

  @override
  ConsumerState<_SettingsForm> createState() => _SettingsFormState();
}

class _SettingsFormState extends ConsumerState<_SettingsForm> {
  late AccountSettings _s = widget.initial;
  late final _budget = TextEditingController(text: widget.initial.budgetM3?.toStringAsFixed(0) ?? '');
  late final _contact = TextEditingController(text: widget.initial.emergencyContact ?? '');
  bool _busy = false;

  @override
  void dispose() {
    _budget.dispose();
    _contact.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final budget = double.tryParse(_budget.text);
    final updated = _s.copyWith(
      budgetM3: budget,
      clearBudget: budget == null,
      emergencyContact: _contact.text.trim(),
    );
    if (updated.awayMode && (updated.emergencyContact ?? '').isEmpty) {
      showMessage(context, 'Add an emergency contact for Away Mode.', error: true);
      return;
    }
    setState(() => _busy = true);
    try {
      await ref.read(repositoryProvider).saveSettings(widget.accountId, updated);
      ref.invalidate(settingsProvider(widget.accountId));
      ref.invalidate(summaryProvider);
      if (mounted) showMessage(context, 'Settings saved');
    } catch (e) {
      if (mounted) showMessage(context, e.toString(), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return PageBody(
      children: [
        const SectionTitle('Monthly budget'),
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                controller: _budget,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: const InputDecoration(labelText: 'Budget per month', suffixText: 'm³'),
              ),
              const SizedBox(height: 8),
              const Text(
                'We warn you at 80% and again when you reach the budget. Leave empty for no budget.',
                style: TextStyle(color: AppColors.textMuted, fontSize: 13),
              ),
            ],
          ),
        ),
        const SectionTitle('Notifications'),
        AppCard(
          padding: EdgeInsets.zero,
          child: Column(children: [
            SwitchListTile(
              value: _s.leakAlerts,
              onChanged: (v) => setState(() => _s = _s.copyWith(leakAlerts: v)),
              title: const Text('Leak alerts'),
              subtitle: const Text('Continuous flow for hours, or flow during the night'),
            ),
            const Divider(),
            SwitchListTile(
              value: _s.usageAlerts,
              onChanged: (v) => setState(() => _s = _s.copyWith(usageAlerts: v)),
              title: const Text('High usage & budget'),
              subtitle: const Text('Unusual daily use and budget warnings'),
            ),
            const Divider(),
            SwitchListTile(
              value: _s.billAlerts,
              onChanged: (v) => setState(() => _s = _s.copyWith(billAlerts: v)),
              title: const Text('Bills & payments'),
              subtitle: const Text('New bills, due dates and payment receipts'),
            ),
          ]),
        ),
        const SectionTitle('Away Mode'),
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: _s.awayMode,
                onChanged: (v) => setState(() => _s = _s.copyWith(awayMode: v)),
                title: const Text('I am away from home'),
                subtitle: const Text('Any water flow raises an alert and notifies your emergency contact'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _contact,
                keyboardType: TextInputType.phone,
                decoration: const InputDecoration(labelText: 'Emergency contact number'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 24),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
              : const Text('Save settings'),
        ),
      ],
    );
  }
}
