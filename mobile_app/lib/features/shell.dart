import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/theme.dart';
import '../state/providers.dart';

/// Five-tab shell (Home, Usage, Bills, Alerts, More). On wide screens (the
/// Flutter Web build) it switches to a left navigation rail.
class AppShell extends ConsumerWidget {
  const AppShell({super.key, required this.shell});

  final StatefulNavigationShell shell;

  void _go(int i) => shell.goBranch(i, initialLocation: i == shell.currentIndex);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final unread = ref.watch(unreadAlertCountProvider);
    Widget alertsIcon(IconData icon) => Badge(
          isLabelVisible: unread > 0,
          label: Text('$unread'),
          backgroundColor: AppColors.danger,
          child: Icon(icon),
        );

    final destinations = [
      (const Icon(Icons.home_outlined), const Icon(Icons.home_rounded), 'Home'),
      (const Icon(Icons.show_chart_outlined), const Icon(Icons.show_chart_rounded), 'Usage'),
      (const Icon(Icons.receipt_long_outlined), const Icon(Icons.receipt_long_rounded), 'Bills'),
      (alertsIcon(Icons.notifications_none_rounded), alertsIcon(Icons.notifications_rounded), 'Alerts'),
      (const Icon(Icons.menu_rounded), const Icon(Icons.menu_open_rounded), 'More'),
    ];

    final wide = MediaQuery.sizeOf(context).width >= 900;
    if (wide) {
      return Scaffold(
        body: Row(
          children: [
            NavigationRail(
              backgroundColor: AppColors.surface,
              selectedIndex: shell.currentIndex,
              onDestinationSelected: _go,
              labelType: NavigationRailLabelType.all,
              leading: const Padding(
                padding: EdgeInsets.symmetric(vertical: 16),
                child: Icon(Icons.water_drop_rounded, color: AppColors.water, size: 32),
              ),
              destinations: [
                for (final d in destinations)
                  NavigationRailDestination(icon: d.$1, selectedIcon: d.$2, label: Text(d.$3)),
              ],
            ),
            const VerticalDivider(width: 1),
            Expanded(child: shell),
          ],
        ),
      );
    }

    return Scaffold(
      body: shell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: shell.currentIndex,
        onDestinationSelected: _go,
        destinations: [
          for (final d in destinations) NavigationDestination(icon: d.$1, selectedIcon: d.$2, label: d.$3),
        ],
      ),
    );
  }
}
