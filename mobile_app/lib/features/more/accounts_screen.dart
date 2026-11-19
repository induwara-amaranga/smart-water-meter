import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../core/theme.dart';
import '../../state/providers.dart';
import '../../widgets/common.dart';

class AccountsScreen extends ConsumerWidget {
  const AccountsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final current = ref.watch(currentAccountProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('My meters & accounts')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push('/add-meter'),
        icon: const Icon(Icons.add),
        label: const Text('Add meter'),
      ),
      body: AsyncView(
        value: ref.watch(accountsProvider),
        onRetry: () => ref.invalidate(accountsProvider),
        data: (accounts) => PageBody(
          children: [
            const SizedBox(height: 8),
            for (final a in accounts) ...[
              AppCard(
                onTap: () {
                  ref.read(selectedAccountIdProvider.notifier).select(a.id);
                  context.go('/home');
                },
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.home_work_outlined, color: AppColors.primary),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(a.label, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                        ),
                        if (a.id == current?.id) const StatusPill(label: 'Viewing', color: AppColors.primary),
                      ],
                    ),
                    const SizedBox(height: 8),
                    LabelValue('Account number', a.accountNo),
                    LabelValue('Address', a.address),
                    LabelValue('Meter', a.meterId),
                    _MeterStatus(meterId: a.meterId),
                  ],
                ),
              ),
              const SizedBox(height: 12),
            ],
            const SizedBox(height: 72),
          ],
        ),
      ),
    );
  }
}

class _MeterStatus extends ConsumerWidget {
  const _MeterStatus({required this.meterId});

  final String meterId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(summaryProvider(meterId)).value;
    if (s == null) return const LabelValue('Status', '…');
    return Column(
      children: [
        LabelValue(
          'Status',
          s.online ? 'Online' : 'Offline · last seen ${timeAgo(s.lastSeen)}',
          valueColor: s.online ? AppColors.success : AppColors.textMuted,
        ),
        LabelValue('Wi-Fi signal', '${s.rssi} dBm'),
        LabelValue('Firmware', s.firmware),
      ],
    );
  }
}
