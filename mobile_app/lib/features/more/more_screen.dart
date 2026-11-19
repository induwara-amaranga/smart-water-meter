import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/config.dart';
import '../../core/theme.dart';
import '../../data/mock_repository.dart';
import '../../state/providers.dart';
import '../../widgets/common.dart';

class MoreScreen extends ConsumerWidget {
  const MoreScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final customer = ref.watch(authProvider).value;
    final account = ref.watch(currentAccountProvider);

    Widget tile(IconData icon, String title, String? subtitle, VoidCallback onTap) => ListTile(
          leading: Icon(icon, color: AppColors.primary),
          title: Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
          subtitle: subtitle == null ? null : Text(subtitle, style: const TextStyle(color: AppColors.textMuted)),
          trailing: const Icon(Icons.chevron_right, color: AppColors.textMuted),
          onTap: onTap,
        );

    return Scaffold(
      appBar: AppBar(title: const Text('More')),
      body: PageBody(
        children: [
          const SizedBox(height: 8),
          AppCard(
            onTap: () => context.go('/more/profile'),
            child: Row(
              children: [
                CircleAvatar(
                  radius: 28,
                  backgroundColor: AppColors.primaryDark,
                  child: Text(
                    (customer?.name.isNotEmpty ?? false) ? customer!.name[0].toUpperCase() : '?',
                    style: const TextStyle(fontSize: 24, color: Colors.white, fontWeight: FontWeight.w800),
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(customer?.name ?? '', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                      Text(customer?.phone ?? customer?.email ?? '',
                          style: const TextStyle(color: AppColors.textMuted)),
                    ],
                  ),
                ),
                const Icon(Icons.edit_outlined, color: AppColors.textMuted),
              ],
            ),
          ),
          const SectionTitle('Account'),
          AppCard(
            padding: EdgeInsets.zero,
            child: Column(children: [
              tile(Icons.speed_rounded, 'My meters & accounts', account == null ? null : 'Viewing ${account.label}',
                  () => context.go('/more/accounts')),
              const Divider(indent: 56),
              tile(Icons.tune_rounded, 'Budget & alerts', 'Monthly budget, leak alerts, Away Mode',
                  () => context.go('/more/settings')),
            ]),
          ),
          const SectionTitle('Help'),
          AppCard(
            padding: EdgeInsets.zero,
            child: Column(children: [
              tile(Icons.support_agent_rounded, 'Complaints & support', 'Report a problem, track tickets',
                  () => context.go('/more/tickets')),
              const Divider(indent: 56),
              tile(Icons.calculate_rounded, 'Bill calculator', 'See what a given usage would cost',
                  () => context.go('/more/calculator')),
              const Divider(indent: 56),
              tile(Icons.help_outline_rounded, 'FAQ', null, () => context.go('/more/faq')),
            ]),
          ),
          if (AppConfig.useMock) ...[
            const SectionTitle('Demo tools'),
            AppCard(
              padding: EdgeInsets.zero,
              child: tile(Icons.water_damage_outlined, 'Simulate a leak alert', 'Raises a leak alert on this meter',
                  () {
                final repo = ref.read(repositoryProvider);
                if (repo is MockWaterRepository && account != null) {
                  repo.simulateLeak(account.meterId);
                  ref.invalidate(alertsProvider);
                  ref.invalidate(summaryProvider(account.meterId));
                  showMessage(context, 'Leak alert raised. Check the Alerts tab.');
                }
              }),
            ),
          ],
          const SizedBox(height: 24),
          OutlinedButton.icon(
            style: OutlinedButton.styleFrom(foregroundColor: AppColors.danger),
            onPressed: () async {
              final ok = await showDialog<bool>(
                context: context,
                builder: (ctx) => AlertDialog(
                  backgroundColor: AppColors.surfaceHigh,
                  title: const Text('Sign out?'),
                  actions: [
                    TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
                    TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Sign out')),
                  ],
                ),
              );
              if (ok == true) await ref.read(authProvider.notifier).logout();
            },
            icon: const Icon(Icons.logout),
            label: const Text('Sign out'),
          ),
          const SizedBox(height: 16),
          const Center(
            child: Text('Smart Water · v1.0.0', style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
          ),
        ],
      ),
    );
  }
}
