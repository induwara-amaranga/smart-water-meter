import 'package:flutter/material.dart';

import '../../core/theme.dart';
import '../../widgets/common.dart';

class FaqScreen extends StatelessWidget {
  const FaqScreen({super.key});

  static const _faqs = [
    (
      'How accurate is my smart meter?',
      'The flow sensor is accurate to about ±10%. Very slow drips (below about 1 litre per minute) '
          'may not be detected, so check taps and toilets if you suspect a small leak.'
    ),
    (
      'What happens if my Wi-Fi goes down?',
      'The meter keeps measuring and stores readings on its memory card. When Wi-Fi returns it uploads '
          'them, so nothing is lost. Bills that include these readings are marked as such.'
    ),
    (
      'How is my bill calculated?',
      'Water is priced in tiers: the first cubic metres cost less, and each tier above costs more per m³. '
          'A fixed monthly service charge is added. Open any bill and tap it to see the breakdown.'
    ),
    (
      'What does closing the valve do?',
      'It stops all water to your property until you open it again. The app shows "Closing…" until the '
          'meter confirms. Keep the manual bypass valve accessible for emergencies.'
    ),
    (
      'How are leaks detected?',
      'If water flows continuously for several hours, or flows in the middle of the night, you get a leak '
          'alert. In Away Mode any flow raises an alert.'
    ),
    (
      'Who can see my usage?',
      'Only you and family members you add. Water board staff access is logged.'
    ),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('FAQ')),
      body: PageBody(
        children: [
          const SizedBox(height: 8),
          for (final (q, a) in _faqs) ...[
            AppCard(
              padding: EdgeInsets.zero,
              child: Theme(
                data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                child: ExpansionTile(
                  title: Text(q, style: const TextStyle(fontWeight: FontWeight.w700)),
                  childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                  expandedAlignment: Alignment.centerLeft,
                  children: [Text(a, style: const TextStyle(color: AppColors.textMuted, height: 1.4))],
                ),
              ),
            ),
            const SizedBox(height: 10),
          ],
        ],
      ),
    );
  }
}
