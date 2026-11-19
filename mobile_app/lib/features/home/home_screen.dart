import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../core/tariff_calculator.dart';
import '../../core/theme.dart';
import '../../data/models.dart';
import '../../state/providers.dart';
import '../../widgets/common.dart';

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final customer = ref.watch(authProvider).value;
    final accounts = ref.watch(accountsProvider);
    final account = ref.watch(currentAccountProvider);

    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 68,
        title: Row(
          children: [
            const Icon(Icons.water_drop_rounded, color: AppColors.water, size: 34),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Smart Water', style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800)),
                  Text(
                    customer?.name ?? '',
                    style: const TextStyle(fontSize: 13, color: AppColors.primary, fontWeight: FontWeight.w500),
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: const [AccountSwitcher()],
      ),
      body: AsyncView(
        value: accounts,
        onRetry: () => ref.invalidate(accountsProvider),
        data: (list) {
          if (account == null) {
            return EmptyState(
              icon: Icons.speed_rounded,
              title: 'Add your water meter',
              message: 'Link your smart meter to see live usage, control your supply and get your bills here.',
              action: FilledButton.icon(
                onPressed: () => context.push('/add-meter'),
                icon: const Icon(Icons.add),
                label: const Text('Add meter'),
              ),
            );
          }
          return _HomeBody(account: account);
        },
      ),
    );
  }
}

class _HomeBody extends ConsumerWidget {
  const _HomeBody({required this.account});

  final Account account;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final summary = ref.watch(summaryProvider(account.meterId));

    Future<void> refresh() async {
      ref.invalidate(summaryProvider(account.meterId));
      ref.invalidate(balanceProvider(account.id));
      ref.invalidate(alertsProvider);
      await ref.read(summaryProvider(account.meterId).future);
    }

    return PageBody(
      onRefresh: refresh,
      children: [
        if (summary.value?.topAlert case final alert?) ...[
          _AlertStrip(alert: alert),
          const SizedBox(height: 12),
        ],
        _BalanceCard(account: account),
        const SectionTitle('Live'),
        AsyncView(
          value: summary,
          onRetry: () => ref.invalidate(summaryProvider(account.meterId)),
          data: (s) => Column(
            children: [
              _LiveFlowCard(summary: s),
              const SizedBox(height: 12),
              _MonthCard(summary: s),
              const SizedBox(height: 12),
              _ValveCard(meterId: s.meterId, online: s.online),
            ],
          ),
        ),
        const SectionTitle('Quick actions'),
        const _QuickActions(),
      ],
    );
  }
}

// ------------------------------------------------------------------ alert

class _AlertStrip extends StatelessWidget {
  const _AlertStrip({required this.alert});

  final AppAlert alert;

  @override
  Widget build(BuildContext context) {
    final color = severityColor(alert.severity);
    return AppCard(
      color: color.withValues(alpha: 0.12),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      onTap: () => context.go('/alerts'),
      child: Row(
        children: [
          Icon(alertIcon(alert.type), color: color),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(alert.title, style: TextStyle(fontWeight: FontWeight.w800, color: color)),
                const SizedBox(height: 2),
                Text(alert.message,
                    maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
              ],
            ),
          ),
          const Icon(Icons.chevron_right, color: AppColors.textMuted),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------- balance

class _BalanceCard extends ConsumerWidget {
  const _BalanceCard({required this.account});

  final Account account;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final balance = ref.watch(balanceProvider(account.id));
    final due = balance.value?.amountDueCents;
    final hasDue = (due ?? 0) > 0;

    return AppCard(
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: AppColors.primaryDark,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Icon(Icons.account_balance_wallet_rounded, color: Colors.white),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Account number', style: TextStyle(color: AppColors.textMuted, fontSize: 13)),
                      Text(account.accountNo, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                    ],
                  ),
                ),
                IconButton.filledTonal(
                  tooltip: 'Refresh',
                  onPressed: () => ref.invalidate(balanceProvider(account.id)),
                  icon: const Icon(Icons.refresh),
                ),
              ],
            ),
          ),
          Container(
            width: double.infinity,
            color: hasDue ? AppColors.dangerSurface : AppColors.success.withValues(alpha: 0.10),
            padding: const EdgeInsets.symmetric(vertical: 18),
            child: Column(
              children: [
                const Text('Amount due', style: TextStyle(fontSize: 15)),
                const SizedBox(height: 4),
                Text(
                  due == null ? '—' : formatMoney(due),
                  style: TextStyle(
                    fontSize: 32,
                    fontWeight: FontWeight.w900,
                    color: hasDue ? const Color(0xFFF87171) : AppColors.success,
                  ),
                ),
                const SizedBox(height: 8),
                if (balance.hasValue)
                  hasDue
                      ? StatusPill(
                          label: balance.value!.dueDate == null
                              ? 'Payment required'
                              : 'Due ${formatDate(balance.value!.dueDate!)}',
                          color: AppColors.danger,
                          icon: Icons.error_rounded,
                        )
                      : const StatusPill(label: 'All paid', color: AppColors.success, icon: Icons.check_circle),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(account.holderName, style: const TextStyle(fontWeight: FontWeight.w700)),
                      Text('Meter ${account.meterId}',
                          style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
                    ],
                  ),
                ),
                if (balance.value?.lastPaymentAt case final paidAt?)
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      const Text('Last payment', style: TextStyle(color: AppColors.textMuted, fontSize: 13)),
                      Text(
                        '${formatMoney(balance.value!.lastPaymentCents ?? 0)} · ${formatDate(paidAt)}',
                        style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                      ),
                    ],
                  ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Expanded(
                  child: FilledButton.icon(
                    style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
                    onPressed: hasDue ? () => context.push('/pay', extra: due) : null,
                    icon: const Icon(Icons.credit_card),
                    label: const Text('Pay now'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () => context.go('/bills'),
                    icon: const Icon(Icons.description_outlined),
                    label: const Text('View bills'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// -------------------------------------------------------------- live flow

class _LiveFlowCard extends ConsumerWidget {
  const _LiveFlowCard({required this.summary});

  final MeterSummary summary;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final live = ref.watch(liveFlowProvider(summary.meterId)).value;
    final flow = summary.online ? (live?.flowLpm ?? summary.flowLpm) : 0.0;
    final total = live?.totalLiters ?? summary.totalLiters;
    final flowing = flow > 0.05;

    return AppCard(
      child: Column(
        children: [
          Row(
            children: [
              summary.online
                  ? const StatusPill(label: 'Online', color: AppColors.success, icon: Icons.circle)
                  : const StatusPill(label: 'Offline', color: AppColors.textMuted, icon: Icons.circle_outlined),
              const SizedBox(width: 8),
              Text(
                summary.online ? 'Updated ${timeAgo(live?.at ?? summary.lastSeen)}' : 'Last seen ${timeAgo(summary.lastSeen)}',
                style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
              ),
              const Spacer(),
              Icon(_signalIcon(summary.rssi), size: 18, color: AppColors.textMuted),
            ],
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              AnimatedContainer(
                duration: const Duration(milliseconds: 400),
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: (flowing ? AppColors.water : AppColors.border).withValues(alpha: 0.18),
                ),
                child: Icon(
                  flowing ? Icons.water_drop_rounded : Icons.water_drop_outlined,
                  size: 34,
                  color: flowing ? AppColors.water : AppColors.textMuted,
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Current flow', style: TextStyle(color: AppColors.textMuted)),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: [
                        AnimatedSwitcher(
                          duration: const Duration(milliseconds: 250),
                          child: Text(
                            formatLpm(flow),
                            key: ValueKey(formatLpm(flow)),
                            style: const TextStyle(fontSize: 44, fontWeight: FontWeight.w900, height: 1.1),
                          ),
                        ),
                        const SizedBox(width: 6),
                        const Text('L/min', style: TextStyle(fontSize: 16, color: AppColors.textMuted)),
                      ],
                    ),
                    Text(flowing ? 'Water is flowing' : 'No water flowing',
                        style: TextStyle(color: flowing ? AppColors.water : AppColors.textMuted, fontSize: 13)),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          const Divider(),
          const SizedBox(height: 8),
          LabelValue('Meter reading', formatReading(total), bold: true),
        ],
      ),
    );
  }

  static IconData _signalIcon(int rssi) {
    if (rssi >= -60) return Icons.wifi_rounded;
    if (rssi >= -70) return Icons.wifi_2_bar_rounded;
    return Icons.wifi_1_bar_rounded;
  }
}

// -------------------------------------------------------------- this month

class _MonthCard extends StatelessWidget {
  const _MonthCard({required this.summary});

  final MeterSummary summary;

  @override
  Widget build(BuildContext context) {
    final m3 = summary.monthUsageM3;
    final pos = TariffCalculator(summary.tariff).position(m3);
    final upper = pos.tierUpperM3;
    final progress = upper == null ? 1.0 : ((m3 - pos.tierLowerM3) / (upper - pos.tierLowerM3)).clamp(0.0, 1.0);
    final nearNext = upper != null && progress >= 0.8;
    final budget = summary.budgetM3;

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: _Stat(label: 'Used this month', value: formatM3(m3), icon: Icons.water_rounded),
              ),
              Container(width: 1, height: 48, color: AppColors.border),
              Expanded(
                child: _Stat(
                  label: 'Estimated bill',
                  value: formatMoney(summary.estimatedBillCents),
                  icon: Icons.receipt_rounded,
                ),
              ),
            ],
          ),
          const SizedBox(height: 18),
          Row(
            children: [
              Text('Tier ${pos.tierIndex + 1}', style: const TextStyle(fontWeight: FontWeight.w800)),
              const SizedBox(width: 8),
              Text('${formatMoney(pos.rateCents)} / m³', style: const TextStyle(color: AppColors.textMuted)),
            ],
          ),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: LinearProgressIndicator(
              value: progress,
              minHeight: 12,
              backgroundColor: AppColors.surfaceHigh,
              color: nearNext ? AppColors.warning : AppColors.primary,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            upper == null
                ? 'You are in the highest tier. Every m³ costs ${formatMoney(pos.rateCents)}.'
                : '${m3.toStringAsFixed(1)} of ${upper.toStringAsFixed(0)} m³ used in this tier. '
                    'After that each m³ costs ${formatMoney(pos.nextRateCents ?? pos.rateCents)}.',
            style: TextStyle(color: nearNext ? AppColors.warning : AppColors.textMuted, fontSize: 13),
          ),
          if (budget != null) ...[
            const SizedBox(height: 14),
            Row(
              children: [
                const Icon(Icons.savings_outlined, size: 18, color: AppColors.textMuted),
                const SizedBox(width: 6),
                Text(
                  'Budget: ${(m3 / budget * 100).clamp(0, 999).toStringAsFixed(0)}% of ${formatM3(budget)}',
                  style: TextStyle(
                    fontSize: 13,
                    color: m3 >= budget * 0.8 ? AppColors.warning : AppColors.textMuted,
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value, required this.icon});

  final String label;
  final String value;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Icon(icon, size: 16, color: AppColors.textMuted),
            const SizedBox(width: 6),
            Flexible(child: Text(label, style: const TextStyle(color: AppColors.textMuted, fontSize: 13))),
          ]),
          const SizedBox(height: 4),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(value, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
          ),
        ],
      ),
    );
  }
}

// ------------------------------------------------------------------ valve

class _ValveCard extends ConsumerWidget {
  const _ValveCard({required this.meterId, required this.online});

  final String meterId;
  final bool online;

  Future<void> _confirm(BuildContext context, WidgetRef ref, {required bool open}) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surfaceHigh,
        icon: Icon(open ? Icons.water_drop_rounded : Icons.block_rounded,
            color: open ? AppColors.water : AppColors.danger, size: 36),
        title: Text(open ? 'Open water supply?' : 'Close water supply?'),
        content: Text(
          open
              ? 'Water will start flowing to your property again.'
              : 'All water to this property will stop until you open the valve again. '
                  'Use this for leaks or when you are away.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(
              minimumSize: const Size(110, 44),
              backgroundColor: open ? AppColors.primary : AppColors.danger,
            ),
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(open ? 'Open' : 'Close'),
          ),
        ],
      ),
    );
    if (ok == true) ref.read(valveProvider(meterId).notifier).set(open: open);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen(valveProvider(meterId), (prev, next) {
      if (next.error != null && next.error != prev?.error) showMessage(context, next.error!, error: true);
      if (prev?.busy == true && !next.busy && next.error == null) {
        showMessage(context, next.state == ValveState.open ? 'Valve opened' : 'Valve closed');
      }
    });

    final valve = ref.watch(valveProvider(meterId));
    final isOpen = valve.state == ValveState.open || valve.state == ValveState.closing;
    final (label, color, icon) = switch (valve.state) {
      ValveState.open => ('Open', AppColors.success, Icons.water_drop_rounded),
      ValveState.closed => ('Closed', AppColors.danger, Icons.block_rounded),
      ValveState.closing => ('Closing…', AppColors.warning, Icons.hourglass_top_rounded),
      ValveState.opening => ('Opening…', AppColors.warning, Icons.hourglass_top_rounded),
      _ => ('Unknown', AppColors.textMuted, Icons.help_outline),
    };

    return AppCard(
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: color.withValues(alpha: 0.15), shape: BoxShape.circle),
            child: valve.busy
                ? SizedBox(width: 26, height: 26, child: CircularProgressIndicator(strokeWidth: 3, color: color))
                : Icon(icon, color: color, size: 26),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Water supply valve', style: TextStyle(color: AppColors.textMuted)),
                Text(label, style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: color)),
                if (!online)
                  const Text('Meter offline: valve control is unavailable until it reconnects',
                      style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
              ],
            ),
          ),
          Transform.scale(
            scale: 1.3,
            child: Switch(
              value: isOpen,
              activeColor: Colors.white,
              activeTrackColor: AppColors.success,
              inactiveTrackColor: AppColors.danger.withValues(alpha: 0.5),
              onChanged: valve.busy || valve.state == null || valve.state == ValveState.unknown
                  ? null
                  : (v) => _confirm(context, ref, open: v),
            ),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------- quick actions

class _QuickActions extends StatelessWidget {
  const _QuickActions();

  @override
  Widget build(BuildContext context) {
    final items = [
      (Icons.report_problem_rounded, 'Complaint', () => context.go('/more/tickets')),
      (Icons.credit_card_rounded, 'Payments', () => context.push('/pay')),
      (Icons.history_rounded, 'History', () => context.go('/bills')),
      (Icons.calculate_rounded, 'Calculator', () => context.go('/more/calculator')),
    ];
    return Row(
      children: [
        for (final (i, item) in items.indexed) ...[
          if (i > 0) const SizedBox(width: 10),
          Expanded(
            child: AppCard(
              padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 4),
              onTap: item.$3,
              child: Column(
                children: [
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: AppColors.primaryDark,
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Icon(item.$1, color: Colors.white),
                  ),
                  const SizedBox(height: 8),
                  FittedBox(
                    child: Text(item.$2, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                  ),
                ],
              ),
            ),
          ),
        ],
      ],
    );
  }
}
