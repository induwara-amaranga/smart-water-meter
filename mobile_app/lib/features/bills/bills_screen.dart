import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../core/theme.dart';
import '../../data/models.dart';
import '../../state/providers.dart';
import '../../widgets/common.dart';

class BillsScreen extends ConsumerWidget {
  const BillsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final account = ref.watch(currentAccountProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Bills'), actions: const [AccountSwitcher()]),
      body: account == null
          ? const EmptyState(icon: Icons.receipt_long, title: 'No bills yet', message: 'Add a meter to see bills.')
          : PageBody(
              onRefresh: () async {
                ref.invalidate(billsProvider(account.id));
                ref.invalidate(estimateProvider(account.id));
                ref.invalidate(balanceProvider(account.id));
              },
              children: [
                const SizedBox(height: 8),
                AsyncView(
                  value: ref.watch(estimateProvider(account.id)),
                  loadingHeight: 120,
                  data: (b) => _EstimateCard(bill: b),
                ),
                const SectionTitle('Past bills'),
                AsyncView(
                  value: ref.watch(billsProvider(account.id)),
                  onRetry: () => ref.invalidate(billsProvider(account.id)),
                  data: (bills) => bills.isEmpty
                      ? const AppCard(child: Text('Your first bill will appear after the end of the month.'))
                      : Column(
                          children: [
                            for (final b in bills) ...[_BillCard(bill: b), const SizedBox(height: 12)],
                          ],
                        ),
                ),
              ],
            ),
    );
  }
}

class _EstimateCard extends StatelessWidget {
  const _EstimateCard({required this.bill});

  final Bill bill;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      color: AppColors.primaryDark.withValues(alpha: 0.35),
      onTap: () => context.go('/bills/detail', extra: bill),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.timelapse_rounded, color: AppColors.water),
              const SizedBox(width: 8),
              Expanded(
                child: Text('${formatMonth(bill.period)} so far',
                    style: const TextStyle(fontWeight: FontWeight.w700)),
              ),
              const StatusPill(label: 'Estimate', color: AppColors.water),
            ],
          ),
          const SizedBox(height: 12),
          Text(formatMoney(bill.totalCents), style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w900)),
          Text('${formatM3(bill.usageM3)} used · updates live from your meter',
              style: const TextStyle(color: AppColors.textMuted)),
          const SizedBox(height: 8),
          const Row(
            children: [
              Flexible(
                child: Text('See how it is calculated',
                    style: TextStyle(color: AppColors.primary, fontWeight: FontWeight.w700)),
              ),
              Icon(Icons.chevron_right, color: AppColors.primary),
            ],
          ),
        ],
      ),
    );
  }
}

class _BillCard extends StatelessWidget {
  const _BillCard({required this.bill});

  final Bill bill;

  @override
  Widget build(BuildContext context) {
    final (statusLabel, statusColor) = switch (bill.status) {
      BillStatus.paid => ('Paid', AppColors.success),
      BillStatus.overdue => ('Overdue', AppColors.danger),
      BillStatus.published => ('Unpaid', AppColors.warning),
      BillStatus.estimate => ('Estimate', AppColors.water),
    };

    return AppCard(
      onTap: () => context.go('/bills/detail', extra: bill),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(formatMonth(bill.period), style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                    StatusPill(label: statusLabel, color: statusColor),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Text(
                formatMoney(bill.totalCents),
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: Color(0xFFF87171)),
              ),
            ],
          ),
          const Padding(padding: EdgeInsets.symmetric(vertical: 10), child: Divider()),
          LabelValue('Consumption', formatM3(bill.usageM3)),
          LabelValue('Current month charge', formatMoney(bill.currentMonthCents), bold: true),
          LabelValue('Meter reading', '${formatReading(bill.openingLiters)} → ${formatReading(bill.closingLiters)}'),
          if (bill.paidAt != null)
            LabelValue('Paid on', formatDate(bill.paidAt!))
          else if (bill.dueDate != null)
            LabelValue('Due date', formatDate(bill.dueDate!), valueColor: AppColors.warning),
          if (bill.dataBasis != DataBasis.live) ...[
            const SizedBox(height: 6),
            _DataBasisNote(basis: bill.dataBasis),
          ],
        ],
      ),
    );
  }
}

class _DataBasisNote extends StatelessWidget {
  const _DataBasisNote({required this.basis});

  final DataBasis basis;

  @override
  Widget build(BuildContext context) {
    final text = basis == DataBasis.sdSynced
        ? 'Includes readings uploaded after the meter was offline'
        : 'Estimated: the meter did not report for part of this month';
    return Row(children: [
      const Icon(Icons.info_outline, size: 16, color: AppColors.textMuted),
      const SizedBox(width: 6),
      Expanded(child: Text(text, style: const TextStyle(color: AppColors.textMuted, fontSize: 12))),
    ]);
  }
}
