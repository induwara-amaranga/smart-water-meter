import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../data/models.dart';
import '../features/alerts/alerts_screen.dart';
import '../features/auth/login_screen.dart';
import '../features/auth/otp_screen.dart';
import '../features/auth/splash_screen.dart';
import '../features/bills/bill_detail_screen.dart';
import '../features/bills/bills_screen.dart';
import '../features/bills/pay_screen.dart';
import '../features/home/home_screen.dart';
import '../features/more/accounts_screen.dart';
import '../features/more/calculator_screen.dart';
import '../features/more/faq_screen.dart';
import '../features/more/more_screen.dart';
import '../features/more/profile_screen.dart';
import '../features/more/settings_screen.dart';
import '../features/more/tickets_screen.dart';
import '../features/onboarding/add_meter_screen.dart';
import '../features/onboarding/wifi_setup_screen.dart';
import '../features/shell.dart';
import '../features/usage/usage_screen.dart';
import '../state/providers.dart';

final _rootKey = GlobalKey<NavigatorState>();

final routerProvider = Provider<GoRouter>((ref) {
  // Bridge Riverpod auth state into go_router's refreshListenable.
  final auth = ValueNotifier<AsyncValue<Customer?>>(const AsyncLoading());
  ref.listen(authProvider, (_, next) => auth.value = next, fireImmediately: true);

  final router = GoRouter(
    navigatorKey: _rootKey,
    initialLocation: '/splash',
    refreshListenable: auth,
    redirect: (context, state) {
      final value = auth.value;
      final loc = state.matchedLocation;
      final onAuthPage = loc == '/login' || loc == '/otp';
      if (value.isLoading && !value.hasValue) return loc == '/splash' ? null : '/splash';
      final loggedIn = value.value != null;
      if (!loggedIn) return onAuthPage ? null : '/login';
      if (onAuthPage || loc == '/splash') return '/home';
      return null;
    },
    routes: [
      GoRoute(path: '/splash', builder: (_, __) => const SplashScreen()),
      GoRoute(path: '/login', builder: (_, __) => const LoginScreen()),
      GoRoute(path: '/otp', builder: (_, s) => OtpScreen(identifier: s.extra as String? ?? '')),
      GoRoute(
        path: '/add-meter',
        parentNavigatorKey: _rootKey,
        builder: (_, __) => const AddMeterScreen(),
        routes: [
          GoRoute(
            path: 'wifi',
            parentNavigatorKey: _rootKey,
            builder: (_, s) => WifiSetupScreen(account: s.extra! as Account),
          ),
        ],
      ),
      GoRoute(
        path: '/pay',
        parentNavigatorKey: _rootKey,
        builder: (_, s) => PayScreen(suggestedCents: s.extra as int?),
      ),
      StatefulShellRoute.indexedStack(
        builder: (_, __, shell) => AppShell(shell: shell),
        branches: [
          StatefulShellBranch(routes: [GoRoute(path: '/home', builder: (_, __) => const HomeScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: '/usage', builder: (_, __) => const UsageScreen())]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/bills',
              builder: (_, __) => const BillsScreen(),
              routes: [
                GoRoute(path: 'detail', builder: (_, s) => BillDetailScreen(bill: s.extra as Bill?)),
              ],
            ),
          ]),
          StatefulShellBranch(routes: [GoRoute(path: '/alerts', builder: (_, __) => const AlertsScreen())]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/more',
              builder: (_, __) => const MoreScreen(),
              routes: [
                GoRoute(path: 'profile', builder: (_, __) => const ProfileScreen()),
                GoRoute(path: 'accounts', builder: (_, __) => const AccountsScreen()),
                GoRoute(path: 'settings', builder: (_, __) => const SettingsScreen()),
                GoRoute(path: 'calculator', builder: (_, __) => const CalculatorScreen()),
                GoRoute(path: 'tickets', builder: (_, __) => const TicketsScreen()),
                GoRoute(path: 'faq', builder: (_, __) => const FaqScreen()),
              ],
            ),
          ]),
        ],
      ),
    ],
  );

  ref.onDispose(() {
    router.dispose();
    auth.dispose();
  });
  return router;
});
