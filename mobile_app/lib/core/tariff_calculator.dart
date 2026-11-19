import '../data/models.dart';

/// Tiered (slab) pricing, mirrored from the backend billing engine so the app can
/// show live estimates, the tier progress bar and the bill calculator offline.
///
/// Example from the design doc: 12 m³ with 0–10 @ Rs.10 and >10 @ Rs.15 plus a
/// Rs.400 service charge gives 10×10 + 2×15 + 400 = Rs.530.
class TariffCalculator {
  const TariffCalculator(this.tariff);

  final Tariff tariff;

  List<BillLine> usageLines(double usageM3) {
    final lines = <BillLine>[];
    var lower = 0.0;
    for (var i = 0; i < tariff.slabs.length; i++) {
      final slab = tariff.slabs[i];
      final upper = slab.upToM3 ?? double.infinity;
      if (usageM3 <= lower) break;
      final qty = (usageM3 < upper ? usageM3 : upper) - lower;
      final label = slab.upToM3 == null
          ? 'Tier ${i + 1} (above ${_n(lower)} m³)'
          : 'Tier ${i + 1} (${_n(lower)}–${_n(upper)} m³)';
      lines.add(BillLine(
        kind: BillLineKind.tier,
        description: label,
        qtyM3: qty,
        rateCents: slab.rateCents,
        amountCents: (qty * slab.rateCents).round(),
      ));
      lower = upper;
    }
    return lines;
  }

  List<BillLine> billLines(double usageM3, {int arrearsCents = 0}) => [
        ...usageLines(usageM3),
        BillLine(kind: BillLineKind.service, description: 'Service charge', amountCents: tariff.serviceChargeCents),
        if (arrearsCents != 0)
          BillLine(kind: BillLineKind.arrears, description: 'Arrears brought forward', amountCents: arrearsCents),
      ];

  int totalCents(double usageM3) => billLines(usageM3).fold(0, (s, l) => s + l.amountCents);

  TierPosition position(double usageM3) {
    var lower = 0.0;
    for (var i = 0; i < tariff.slabs.length; i++) {
      final slab = tariff.slabs[i];
      final upper = slab.upToM3;
      if (upper == null || usageM3 < upper) {
        final next = i + 1 < tariff.slabs.length ? tariff.slabs[i + 1] : null;
        return TierPosition(
          tierIndex: i,
          tierLowerM3: lower,
          tierUpperM3: upper,
          rateCents: slab.rateCents,
          nextRateCents: next?.rateCents,
        );
      }
      lower = upper;
    }
    final last = tariff.slabs.last;
    return TierPosition(
      tierIndex: tariff.slabs.length - 1,
      tierLowerM3: lower,
      tierUpperM3: null,
      rateCents: last.rateCents,
      nextRateCents: null,
    );
  }

  static String _n(double v) => v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(1);
}

class TierPosition {
  const TierPosition({
    required this.tierIndex,
    required this.tierLowerM3,
    required this.tierUpperM3,
    required this.rateCents,
    required this.nextRateCents,
  });

  final int tierIndex;
  final double tierLowerM3;

  /// Null when the customer is in the open-ended top tier.
  final double? tierUpperM3;
  final int rateCents;
  final int? nextRateCents;
}
