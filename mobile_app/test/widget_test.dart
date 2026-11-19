import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smart_water_app/core/tariff_calculator.dart';
import 'package:smart_water_app/data/models.dart';
import 'package:smart_water_app/main.dart';

void main() {
  group('TariffCalculator', () {
    // Tariff from the design doc example: 0–10 @ Rs.10, above @ Rs.15, Rs.400 service.
    final docTariff = Tariff(
      name: 'Doc example',
      slabs: const [TariffSlab(upToM3: 10, rateCents: 1000), TariffSlab(upToM3: null, rateCents: 1500)],
      serviceChargeCents: 40000,
      effectiveFrom: DateTime(2026),
    );

    test('12 m³ costs Rs.530 (design doc worked example)', () {
      final calc = TariffCalculator(docTariff);
      expect(calc.totalCents(12), 53000);
      final tiers = calc.usageLines(12);
      expect(tiers.map((l) => l.amountCents), [10000, 3000]);
      expect(tiers.map((l) => l.qtyM3), [10, 2]);
    });

    test('zero usage is only the service charge', () {
      expect(TariffCalculator(docTariff).totalCents(0), 40000);
    });

    test('tier position reports the next rate', () {
      final p = TariffCalculator(docTariff).position(7.2);
      expect(p.tierIndex, 0);
      expect(p.tierUpperM3, 10);
      expect(p.nextRateCents, 1500);
      final top = TariffCalculator(docTariff).position(15);
      expect(top.tierIndex, 1);
      expect(top.tierUpperM3, isNull);
    });
  });

  testWidgets('starts on the sign-in screen in demo mode', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: SmartWaterApp()));
    await tester.pumpAndSettle();
    expect(find.text('Send code'), findsOneWidget);
    expect(find.text('Mobile number or email'), findsOneWidget);
  });

  testWidgets('demo walkthrough: sign in, every tab, bill breakdown, close valve', (tester) async {
    // A typical phone: 411 x 914 logical pixels.
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 2.625;
    addTearDown(tester.view.reset);

    // Animations and live timers never settle, so advance time explicitly.
    Future<void> wait([int ms = 1200]) async {
      for (var i = 0; i < ms ~/ 100; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    await tester.pumpWidget(const ProviderScope(child: SmartWaterApp()));
    await wait();

    await tester.enterText(find.byType(TextField), '0771234567');
    await tester.tap(find.text('Send code'));
    await wait();
    await tester.enterText(find.byType(TextField), '123456');
    await wait(2500);

    // Home
    expect(find.text('Send code'), findsNothing, reason: 'should have left the sign-in screen');
    expect(find.text('Amount due'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('Current flow'), 300);
    expect(find.text('L/min'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('Water supply valve'), 300);

    // Close the valve: confirm dialog, then "Closing…", then confirmed.
    await tester.ensureVisible(find.byType(Switch));
    await wait(300);
    await tester.tap(find.byType(Switch));
    await wait(500);
    expect(find.text('Close water supply?'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Close'));
    await wait(300);
    expect(find.text('Closing…'), findsOneWidget);
    await wait(3000);
    expect(find.text('Closed'), findsOneWidget);

    for (final tab in ['Usage', 'Bills', 'Alerts', 'More']) {
      await tester.tap(find.descendant(of: find.byType(NavigationBar), matching: find.text(tab)));
      await wait();
      expect(tester.takeException(), isNull, reason: 'opening $tab');
    }

    // Bill breakdown
    await tester.tap(find.descendant(of: find.byType(NavigationBar), matching: find.text('Bills')));
    await wait();
    await tester.tap(find.text('See how it is calculated'));
    await wait();
    expect(find.text('How your bill is calculated'), findsOneWidget);
    expect(find.text('Service charge'), findsOneWidget);

    // Unmount so timers and streams are disposed before the test ends.
    await tester.pumpWidget(const SizedBox());
    await wait(3000);
  });
}
