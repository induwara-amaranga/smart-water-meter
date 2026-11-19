import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/theme.dart';
import '../../data/models.dart';
import '../../state/providers.dart';
import '../../widgets/common.dart';

enum _Filter { all, leak, usage, device, billing, notice }

extension on _Filter {
  String get label => switch (this) {
        _Filter.all => 'All',
        _Filter.leak => 'Leaks',
        _Filter.usage => 'High usage',
        _Filter.device => 'Device',
        _Filter.billing => 'Billing',
        _Filter.notice => 'Board notices',
      };

  bool matches(AppAlert a) => switch (this) {
        _Filter.all => true,
        _Filter.leak => a.type == AlertType.leak,
        _Filter.usage => a.type == AlertType.highUsage || a.type == AlertType.budget,
        _Filter.device => a.type == AlertType.device,
        _Filter.billing => a.type == AlertType.billing,
        _Filter.notice => a.type == AlertType.notice,
      };
}

class AlertsScreen extends ConsumerStatefulWidget {
  const AlertsScreen({super.key});

  @override
  ConsumerState<AlertsScreen> createState() => _AlertsScreenState();
}

class _AlertsScreenState extends ConsumerState<AlertsScreen> {
  _Filter _filter = _Filter.all;

  Future<void> _open(AppAlert alert) async {
    if (!alert.read) {
      await ref.read(repositoryProvider).markAlertRead(alert.id);
      ref.invalidate(alertsProvider);
    }
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppColors.surface,
      showDragHandle: true,
      builder: (_) => _AlertDetail(alert: alert),
    );
  }

  @override
  Widget build(BuildContext context) {
    final alerts = ref.watch(alertsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Alerts')),
      body: Column(
        children: [
          SizedBox(
            height: 56,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              children: [
                for (final f in _Filter.values)
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: ChoiceChip(
                      label: Text(f.label),
                      selected: _filter == f,
                      showCheckmark: false,
                      onSelected: (_) => setState(() => _filter = f),
                    ),
                  ),
              ],
            ),
          ),
          Expanded(
            child: AsyncView(
              value: alerts,
              onRetry: () => ref.invalidate(alertsProvider),
              data: (list) {
                final shown = list.where(_filter.matches).toList();
                if (shown.isEmpty) {
                  return const EmptyState(
                    icon: Icons.notifications_off_outlined,
                    title: 'No alerts',
                    message: 'You will be notified about leaks, high usage, your meter and bills here.',
                  );
                }
                return PageBody(
                  onRefresh: () async => ref.invalidate(alertsProvider),
                  children: [
                    for (final a in shown) ...[
                      _AlertTile(alert: a, onTap: () => _open(a)),
                      const SizedBox(height: 10),
                    ],
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _AlertTile extends StatelessWidget {
  const _AlertTile({required this.alert, required this.onTap});

  final AppAlert alert;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = severityColor(alert.severity);
    return AppCard(
      onTap: onTap,
      padding: const EdgeInsets.all(14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: color.withValues(alpha: 0.15), shape: BoxShape.circle),
            child: Icon(alertIcon(alert.type), color: color, size: 22),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  Expanded(
                    child: Text(
                      alert.title,
                      style: TextStyle(fontWeight: alert.read ? FontWeight.w600 : FontWeight.w800),
                    ),
                  ),
                  if (!alert.read)
                    Container(
                      width: 9,
                      height: 9,
                      decoration: const BoxDecoration(color: AppColors.primary, shape: BoxShape.circle),
                    ),
                ]),
                const SizedBox(height: 4),
                Text(alert.message,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
                const SizedBox(height: 6),
                Text(timeAgo(alert.createdAt), style: const TextStyle(color: AppColors.textMuted, fontSize: 12)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _AlertDetail extends ConsumerWidget {
  const _AlertDetail({required this.alert});

  final AppAlert alert;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final color = severityColor(alert.severity);
    final meterId = alert.meterId;
    final valve = meterId == null ? null : ref.watch(valveProvider(meterId));

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Icon(alertIcon(alert.type), color: color, size: 44),
            const SizedBox(height: 12),
            Text(alert.title,
                textAlign: TextAlign.center, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            Text(formatDateTime(alert.createdAt),
                textAlign: TextAlign.center, style: const TextStyle(color: AppColors.textMuted)),
            const SizedBox(height: 16),
            Text(alert.message, style: const TextStyle(fontSize: 15, height: 1.4)),
            if (alert.type == AlertType.leak && meterId != null) ...[
              const SizedBox(height: 24),
              FilledButton.icon(
                style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
                onPressed: valve == null || valve.busy || valve.state == ValveState.closed
                    ? null
                    : () => ref.read(valveProvider(meterId).notifier).set(open: false),
                icon: valve?.busy == true
                    ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.block_rounded),
                label: Text(switch (valve?.state) {
                  ValveState.closing => 'Closing…',
                  ValveState.closed => 'Valve closed',
                  _ => 'Close water valve',
                }),
              ),
            ],
            const SizedBox(height: 12),
            OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Close')),
          ],
        ),
      ),
    );
  }
}
