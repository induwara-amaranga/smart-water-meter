import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/tariff_calculator.dart';
import '../../core/theme.dart';
import '../../state/providers.dart';
import '../../widgets/common.dart';

class CalculatorScreen extends ConsumerStatefulWidget {
  const CalculatorScreen({super.key});

  @override
  ConsumerState<CalculatorScreen> createState() => _CalculatorScreenState();
}

class _CalculatorScreenState extends ConsumerState<CalculatorScreen> {
  double _m3 = 12;
  final _controller = TextEditingController(text: '12');

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Bill calculator')),
      body: AsyncView(
        value: ref.watch(tariffProvider),
        onRetry: () => ref.invalidate(tariffProvider),
        data: (tariff) {
          final calc = TariffCalculator(tariff);
          final lines = calc.billLines(_m3);
          final total = lines.fold<int>(0, (s, l) => s + l.amountCents);
          return PageBody(
            children: [
              const SizedBox(height: 8),
              AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Water used in a month', style: TextStyle(color: AppColors.textMuted)),
                    const SizedBox(height: 8),
                    TextField(
                      controller: _controller,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800),
                      decoration: const InputDecoration(suffixText: 'm³'),
                      onChanged: (v) => setState(() => _m3 = (double.tryParse(v) ?? 0).clamp(0, 500)),
                    ),
                    Slider(
                      value: _m3.clamp(0, 60),
                      max: 60,
                      divisions: 120,
                      label: '${_m3.toStringAsFixed(1)} m³',
                      onChanged: (v) => setState(() {
                        _m3 = v;
                        _controller.text = v.toStringAsFixed(1);
                      }),
                    ),
                    const Text(
                      'A typical household of 4 uses about 12–18 m³ a month. 1 m³ = 1,000 litres.',
                      style: TextStyle(color: AppColors.textMuted, fontSize: 12),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              AppCard(
                child: Column(
                  children: [
                    for (final l in lines)
                      LabelValue(
                        l.qtyM3 == null
                            ? l.description
                            : '${l.description}\n${l.qtyM3!.toStringAsFixed(1)} m³ × ${formatMoney(l.rateCents ?? 0)}',
                        formatMoney(l.amountCents),
                      ),
                    const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Divider()),
                    LabelValue('Estimated bill', formatMoney(total), bold: true),
                  ],
                ),
              ),
              const SectionTitle('Current tariff'),
              AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${tariff.name} · from ${formatDate(tariff.effectiveFrom)}',
                        style: const TextStyle(color: AppColors.textMuted)),
                    const SizedBox(height: 8),
                    for (final (i, s) in tariff.slabs.indexed)
                      LabelValue(
                        s.upToM3 == null
                            ? 'Above ${tariff.slabs[i - 1].upToM3!.toStringAsFixed(0)} m³'
                            : '${i == 0 ? 0 : tariff.slabs[i - 1].upToM3!.toStringAsFixed(0)}–${s.upToM3!.toStringAsFixed(0)} m³',
                        '${formatMoney(s.rateCents)} / m³',
                      ),
                    LabelValue('Service charge', '${formatMoney(tariff.serviceChargeCents)} / month'),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}
