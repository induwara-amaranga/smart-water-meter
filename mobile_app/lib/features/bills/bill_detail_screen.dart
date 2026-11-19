import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../core/theme.dart';
import '../../data/models.dart';
import '../../widgets/common.dart';

/// "Explain my bill": per-tier lines, service charge, arrears, readings.
class BillDetailScreen extends StatelessWidget {
  const BillDetailScreen({super.key, required this.bill});

  final Bill? bill;

  @override
  Widget build(BuildContext context) {
    final b = bill;
    if (b == null) {
      return Scaffold(
        appBar: AppBar(),
        body: const EmptyState(icon: Icons.receipt_long, title: 'Bill not found'),
      );
    }
    final isEstimate = b.status == BillStatus.estimate;
    final tierLines = b.lines.where((l) => l.kind == BillLineKind.tier).toList();
    final otherLines = b.lines.where((l) => l.kind != BillLineKind.tier).toList();

    return Scaffold(
      appBar: AppBar(title: Text(isEstimate ? 'Current estimate' : formatMonth(b.period))),
      body: PageBody(
        children: [
          const SizedBox(height: 8),
          AppCard(
            child: Column(
              children: [
                Text(isEstimate ? 'Estimated so far' : 'Total for ${formatMonth(b.period)}',
                    style: const TextStyle(color: AppColors.textMuted)),
                const SizedBox(height: 4),
                Text(formatMoney(b.totalCents), style: const TextStyle(fontSize: 36, fontWeight: FontWeight.w900)),
                const SizedBox(height: 4),
                Text('${formatM3(b.usageM3)} used', style: const TextStyle(color: AppColors.textMuted)),
              ],
            ),
          ),
          const SectionTitle('How your bill is calculated'),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Water is priced in tiers. The first units are cheapest and each tier above costs more per m³.',
                  style: TextStyle(color: AppColors.textMuted, fontSize: 13),
                ),
                const SizedBox(height: 12),
                for (final l in tierLines) _TierLine(line: l),
                const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Divider()),
                LabelValue('Usage charge', formatMoney(b.usageChargeCents), bold: true),
                for (final l in otherLines)
                  LabelValue(
                    l.description,
                    formatMoney(l.amountCents),
                    valueColor: l.amountCents < 0 ? AppColors.success : null,
                  ),
                const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Divider()),
                LabelValue('Total', formatMoney(b.totalCents), bold: true),
              ],
            ),
          ),
          const SectionTitle('Meter readings'),
          AppCard(
            child: Column(
              children: [
                LabelValue('Previous reading', formatReading(b.openingLiters)),
                LabelValue('Current reading', formatReading(b.closingLiters)),
                LabelValue('Consumption', formatM3(b.usageM3), bold: true),
                if (b.readingDate != null) LabelValue('Reading date', formatDate(b.readingDate!)),
                if (b.dueDate != null && !isEstimate) LabelValue('Due date', formatDate(b.dueDate!)),
                if (b.paidAt != null) LabelValue('Paid on', formatDate(b.paidAt!), valueColor: AppColors.success),
              ],
            ),
          ),
          const SizedBox(height: 20),
          if (!isEstimate) ...[
            if (b.status != BillStatus.paid)
              FilledButton.icon(
                style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
                onPressed: () => context.push('/pay', extra: b.totalCents),
                icon: const Icon(Icons.credit_card),
                label: const Text('Pay this bill'),
              ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: () => showMessage(context, 'The PDF bill will download once the backend is connected.'),
              icon: const Icon(Icons.picture_as_pdf_outlined),
              label: const Text('Download PDF'),
            ),
          ] else
            const Text(
              'This estimate uses the current tariff and your live meter reading. '
              'The final bill is issued after the month ends.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppColors.textMuted, fontSize: 13),
            ),
        ],
      ),
    );
  }
}

class _TierLine extends StatelessWidget {
  const _TierLine({required this.line});

  final BillLine line;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(line.description, style: const TextStyle(fontWeight: FontWeight.w600)),
                Text(
                  '${line.qtyM3!.toStringAsFixed(2)} m³ × ${formatMoney(line.rateCents ?? 0)}',
                  style: const TextStyle(color: AppColors.textMuted, fontSize: 13),
                ),
              ],
            ),
          ),
          Text(formatMoney(line.amountCents), style: const TextStyle(fontWeight: FontWeight.w700)),
        ],
      ),
    );
  }
}
