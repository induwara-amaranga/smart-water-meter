import 'package:intl/intl.dart';

final _money = NumberFormat('#,##0.00', 'en_US');
final _volume = NumberFormat('#,##0.0', 'en_US');
final _volumePrecise = NumberFormat('#,##0.000', 'en_US');

/// 477558 -> "Rs. 4,775.58"
String formatMoney(int cents) => 'Rs. ${_money.format(cents / 100)}';

/// Cubic metres with one decimal: 7.25 -> "7.3 m³"
String formatM3(double m3) => '${_volume.format(m3)} m³';

/// Meter-style reading from litres: 123456.7 L -> "123.457 m³"
String formatReading(double liters) => '${_volumePrecise.format(liters / 1000)} m³';

String formatLpm(double lpm) => lpm.toStringAsFixed(1);

String formatMonth(DateTime d) => DateFormat('MMMM yyyy').format(d);
String formatShortMonth(DateTime d) => DateFormat('MMM').format(d);
String formatDate(DateTime d) => DateFormat('MMM d, yyyy').format(d);
String formatDateTime(DateTime d) => DateFormat('MMM d, h:mm a').format(d);

String timeAgo(DateTime t, {DateTime? now}) {
  final diff = (now ?? DateTime.now()).difference(t);
  if (diff.inSeconds < 60) return 'just now';
  if (diff.inMinutes < 60) return '${diff.inMinutes} min ago';
  if (diff.inHours < 24) return '${diff.inHours} h ago';
  return '${diff.inDays} d ago';
}
