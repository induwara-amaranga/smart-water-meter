import 'dart:math';

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/format.dart';
import '../../core/theme.dart';
import '../../data/models.dart';
import '../../state/providers.dart';
import '../../widgets/common.dart';

class UsageScreen extends ConsumerStatefulWidget {
  const UsageScreen({super.key});

  @override
  ConsumerState<UsageScreen> createState() => _UsageScreenState();
}

class _UsageScreenState extends ConsumerState<UsageScreen> {
  UsageRange _range = UsageRange.week;

  @override
  Widget build(BuildContext context) {
    final account = ref.watch(currentAccountProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Usage'), actions: const [AccountSwitcher()]),
      body: account == null
          ? const EmptyState(icon: Icons.show_chart, title: 'No meter yet', message: 'Add a meter to see usage.')
          : PageBody(
              onRefresh: () async => ref.invalidate(usageProvider((account.meterId, _range))),
              children: [
                const SizedBox(height: 8),
                SegmentedButton<UsageRange>(
                  segments: const [
                    ButtonSegment(value: UsageRange.day, label: Text('Today')),
                    ButtonSegment(value: UsageRange.week, label: Text('Week')),
                    ButtonSegment(value: UsageRange.month, label: Text('Month')),
                  ],
                  selected: {_range},
                  showSelectedIcon: false,
                  onSelectionChanged: (s) => setState(() => _range = s.first),
                ),
                const SizedBox(height: 16),
                AsyncView(
                  value: ref.watch(usageProvider((account.meterId, _range))),
                  loadingHeight: 320,
                  onRetry: () => ref.invalidate(usageProvider((account.meterId, _range))),
                  data: (series) => _UsageContent(series: series, account: account),
                ),
              ],
            ),
    );
  }
}

class _UsageContent extends ConsumerWidget {
  const _UsageContent({required this.series, required this.account});

  final UsageSeries series;
  final Account account;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final total = series.totalLiters;
    final prev = series.previousTotalLiters;
    final change = prev <= 0 ? 0.0 : (total - prev) / prev * 100;
    final prevLabel = switch (series.range) {
      UsageRange.day => 'yesterday',
      UsageRange.week => 'last week',
      UsageRange.month => 'last month',
    };
    final budget = ref.watch(settingsProvider(account.id)).value?.budgetM3;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: _MiniStat(
                label: series.range == UsageRange.day
                    ? 'Used today'
                    : series.range == UsageRange.week
                        ? 'Last 7 days'
                        : 'This month',
                value: total >= 1000 ? formatM3(total / 1000) : '${total.toStringAsFixed(0)} L',
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _MiniStat(
                label: 'vs $prevLabel',
                value: '${change >= 0 ? '+' : ''}${change.toStringAsFixed(0)}%',
                color: change > 10 ? AppColors.warning : AppColors.success,
                icon: change >= 0 ? Icons.trending_up_rounded : Icons.trending_down_rounded,
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        AppCard(
          padding: const EdgeInsets.fromLTRB(8, 20, 16, 8),
          child: SizedBox(height: 260, child: _UsageChart(series: series)),
        ),
        if (series.range == UsageRange.month) ...[
          const SectionTitle('Monthly budget'),
          _BudgetCard(usedM3: total / 1000, budgetM3: budget),
        ],
        const SectionTitle('Compare'),
        AppCard(
          child: Column(
            children: [
              LabelValue('This period', '${(total / 1000).toStringAsFixed(2)} m³', bold: true),
              LabelValue('Previous period', '${(prev / 1000).toStringAsFixed(2)} m³'),
              LabelValue(
                'Average per day',
                '${(total / max(1, _days(series))).toStringAsFixed(0)} L',
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        const Text(
          'Readings are accurate to about ±10%. Very slow drips (under 1 L/min) may not be detected.',
          style: TextStyle(color: AppColors.textMuted, fontSize: 12),
        ),
      ],
    );
  }

  static double _days(UsageSeries s) => switch (s.range) {
        UsageRange.day => 1,
        UsageRange.week => 7,
        UsageRange.month => s.points.length.toDouble(),
      };
}

class _MiniStat extends StatelessWidget {
  const _MiniStat({required this.label, required this.value, this.color, this.icon});

  final String label;
  final String value;
  final Color? color;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
          const SizedBox(height: 4),
          Row(children: [
            if (icon != null) ...[Icon(icon, color: color, size: 22), const SizedBox(width: 4)],
            Flexible(
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(value, style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: color)),
              ),
            ),
          ]),
        ],
      ),
    );
  }
}

class _UsageChart extends StatelessWidget {
  const _UsageChart({required this.series});

  final UsageSeries series;

  String _bottomLabel(DateTime t) => switch (series.range) {
        UsageRange.day => DateFormat('ha').format(t).toLowerCase(),
        UsageRange.week => DateFormat('E').format(t),
        UsageRange.month => '${t.day}',
      };

  bool _showLabel(int i) => switch (series.range) {
        UsageRange.day => i % 4 == 0,
        UsageRange.week => true,
        UsageRange.month => i % 5 == 0,
      };

  @override
  Widget build(BuildContext context) {
    final points = series.points;
    if (points.isEmpty) {
      return const Center(child: Text('No readings yet', style: TextStyle(color: AppColors.textMuted)));
    }
    final maxY = points.map((p) => p.liters).reduce(max) * 1.2;
    final barWidth = switch (series.range) {
      UsageRange.day => 8.0,
      UsageRange.week => 22.0,
      UsageRange.month => 6.0,
    };

    return BarChart(
      BarChartData(
        maxY: max(maxY, 1),
        alignment: BarChartAlignment.spaceAround,
        borderData: FlBorderData(show: false),
        gridData: FlGridData(
          drawVerticalLine: false,
          horizontalInterval: max(maxY / 4, 1),
          getDrawingHorizontalLine: (_) => const FlLine(color: AppColors.border, strokeWidth: 1),
        ),
        titlesData: FlTitlesData(
          topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
          rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
          leftTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 44,
              interval: max(maxY / 4, 1),
              getTitlesWidget: (v, meta) => SideTitleWidget(
                meta: meta,
                child: Text('${v.toStringAsFixed(0)}L',
                    style: const TextStyle(color: AppColors.textMuted, fontSize: 11)),
              ),
            ),
          ),
          bottomTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 28,
              getTitlesWidget: (v, meta) {
                final i = v.toInt();
                if (i < 0 || i >= points.length || !_showLabel(i)) return const SizedBox.shrink();
                return SideTitleWidget(
                  meta: meta,
                  child: Text(_bottomLabel(points[i].start),
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 11)),
                );
              },
            ),
          ),
        ),
        barTouchData: BarTouchData(
          touchTooltipData: BarTouchTooltipData(
            getTooltipColor: (_) => AppColors.surfaceHigh,
            getTooltipItem: (group, _, rod, __) => BarTooltipItem(
              '${_bottomLabel(points[group.x].start)}\n${rod.toY.toStringAsFixed(0)} L',
              const TextStyle(color: AppColors.text, fontWeight: FontWeight.w700),
            ),
          ),
        ),
        barGroups: [
          for (final (i, p) in points.indexed)
            BarChartGroupData(
              x: i,
              barRods: [
                BarChartRodData(
                  toY: p.liters,
                  width: barWidth,
                  borderRadius: const BorderRadius.vertical(top: Radius.circular(4)),
                  gradient: const LinearGradient(
                    colors: [AppColors.primaryDark, AppColors.water],
                    begin: Alignment.bottomCenter,
                    end: Alignment.topCenter,
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

class _BudgetCard extends StatelessWidget {
  const _BudgetCard({required this.usedM3, required this.budgetM3});

  final double usedM3;
  final double? budgetM3;

  @override
  Widget build(BuildContext context) {
    final budget = budgetM3;
    if (budget == null) {
      return const AppCard(
        child: Row(children: [
          Icon(Icons.savings_outlined, color: AppColors.textMuted),
          SizedBox(width: 12),
          Expanded(child: Text('Set a monthly budget in More → Budget & alerts to get a warning at 80%.')),
        ]),
      );
    }
    final ratio = usedM3 / budget;
    final color = ratio >= 1
        ? AppColors.danger
        : ratio >= 0.8
            ? AppColors.warning
            : AppColors.success;
    final now = DateTime.now();
    final daysInMonth = DateTime(now.year, now.month + 1, 0).day;
    final projected = usedM3 / now.day * daysInMonth;

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Text('${formatM3(usedM3)} of ${formatM3(budget)}',
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
            const Spacer(),
            Text('${(ratio * 100).toStringAsFixed(0)}%', style: TextStyle(color: color, fontWeight: FontWeight.w800)),
          ]),
          const SizedBox(height: 10),
          Stack(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: LinearProgressIndicator(
                  value: ratio.clamp(0, 1),
                  minHeight: 14,
                  color: color,
                  backgroundColor: AppColors.surfaceHigh,
                ),
              ),
              // 80 % warning marker.
              Positioned.fill(
                child: FractionallySizedBox(
                  alignment: Alignment.centerLeft,
                  widthFactor: 0.8,
                  child: Align(
                    alignment: Alignment.centerRight,
                    child: Container(width: 2, height: 14, color: AppColors.text.withValues(alpha: 0.7)),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            'At this rate you will use about ${formatM3(projected)} this month.',
            style: TextStyle(color: projected > budget ? AppColors.warning : AppColors.textMuted, fontSize: 13),
          ),
        ],
      ),
    );
  }
}
