import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/theme.dart';
import '../data/models.dart';
import '../state/providers.dart';

class AppCard extends StatelessWidget {
  const AppCard({super.key, required this.child, this.padding = const EdgeInsets.all(16), this.color, this.onTap});

  final Widget child;
  final EdgeInsetsGeometry padding;
  final Color? color;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: color ?? AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: const BorderSide(color: AppColors.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(padding: padding, child: child),
      ),
    );
  }
}

class SectionTitle extends StatelessWidget {
  const SectionTitle(this.text, {super.key, this.action});

  final String text;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 20, 4, 10),
      child: Row(
        children: [
          Expanded(
            child: Text(text, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
          ),
          if (action != null) action!,
        ],
      ),
    );
  }
}

class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.label, required this.color, this.icon});

  final String label;
  final Color color;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[Icon(icon, size: 14, color: color), const SizedBox(width: 4)],
          Flexible(
            child: Text(label, style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w700)),
          ),
        ],
      ),
    );
  }
}

class LabelValue extends StatelessWidget {
  const LabelValue(this.label, this.value, {super.key, this.bold = false, this.valueColor});

  final String label;
  final String value;
  final bool bold;
  final Color? valueColor;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(child: Text(label, style: const TextStyle(color: AppColors.textMuted, fontSize: 15))),
          const SizedBox(width: 12),
          Flexible(
            child: Text(
              value,
              textAlign: TextAlign.right,
              style: TextStyle(
                fontSize: 15,
                fontWeight: bold ? FontWeight.w800 : FontWeight.w600,
                color: valueColor ?? AppColors.text,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Standard loading / error / data switch for an [AsyncValue].
class AsyncView<T> extends StatelessWidget {
  const AsyncView({super.key, required this.value, required this.data, this.onRetry, this.loadingHeight = 160});

  final AsyncValue<T> value;
  final Widget Function(T data) data;
  final VoidCallback? onRetry;
  final double loadingHeight;

  @override
  Widget build(BuildContext context) {
    return value.when(
      data: data,
      loading: () => SizedBox(height: loadingHeight, child: const Center(child: CircularProgressIndicator())),
      error: (e, _) => ErrorBox(message: e.toString(), onRetry: onRetry),
    );
  }
}

class ErrorBox extends StatelessWidget {
  const ErrorBox({super.key, required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Column(
        children: [
          const Icon(Icons.cloud_off_rounded, color: AppColors.textMuted, size: 36),
          const SizedBox(height: 8),
          Text(message, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.textMuted)),
          if (onRetry != null) ...[
            const SizedBox(height: 8),
            TextButton.icon(onPressed: onRetry, icon: const Icon(Icons.refresh), label: const Text('Try again')),
          ],
        ],
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, this.message, this.action});

  final IconData icon;
  final String title;
  final String? message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 56, color: AppColors.primary),
            const SizedBox(height: 16),
            Text(title,
                textAlign: TextAlign.center, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
            if (message != null) ...[
              const SizedBox(height: 8),
              Text(message!, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.textMuted)),
            ],
            if (action != null) ...[const SizedBox(height: 20), action!],
          ],
        ),
      ),
    );
  }
}

/// "Account ▾ Home" dropdown, as in the NWSDB reference header.
class AccountSwitcher extends ConsumerWidget {
  const AccountSwitcher({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final accounts = ref.watch(accountsProvider).value ?? const <Account>[];
    final current = ref.watch(currentAccountProvider);
    if (current == null) return const SizedBox.shrink();

    return PopupMenuButton<String>(
      tooltip: 'Switch account',
      color: AppColors.surfaceHigh,
      onSelected: (id) {
        if (id == '__add') {
          context.push('/add-meter');
        } else {
          ref.read(selectedAccountIdProvider.notifier).select(id);
        }
      },
      itemBuilder: (_) => [
        for (final a in accounts)
          PopupMenuItem(
            value: a.id,
            child: ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(a.id == current.id ? Icons.radio_button_checked : Icons.radio_button_off,
                  color: AppColors.primary),
              title: Text(a.label),
              subtitle: Text(a.accountNo, style: const TextStyle(fontSize: 12)),
            ),
          ),
        const PopupMenuDivider(),
        const PopupMenuItem(
          value: '__add',
          child: ListTile(contentPadding: EdgeInsets.zero, leading: Icon(Icons.add), title: Text('Add meter')),
        ),
      ],
      child: Container(
        margin: const EdgeInsets.only(right: 12),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: AppColors.surfaceHigh,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.border),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.home_outlined, color: AppColors.primary, size: 20),
            const SizedBox(width: 8),
            Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Account', style: TextStyle(fontSize: 11, color: AppColors.textMuted)),
                Text(current.label, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
              ],
            ),
            const SizedBox(width: 6),
            const Icon(Icons.expand_more, color: AppColors.textMuted, size: 20),
          ],
        ),
      ),
    );
  }
}

/// Wraps tab content in a max-width column so the Flutter Web build stays readable.
class PageBody extends StatelessWidget {
  const PageBody({super.key, required this.children, this.onRefresh});

  final List<Widget> children;
  final Future<void> Function()? onRefresh;

  @override
  Widget build(BuildContext context) {
    final list = ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      physics: const AlwaysScrollableScrollPhysics(),
      children: children,
    );
    return Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 720),
        child: onRefresh == null ? list : RefreshIndicator(onRefresh: onRefresh!, child: list),
      ),
    );
  }
}

IconData alertIcon(AlertType t) => switch (t) {
      AlertType.leak => Icons.water_damage_rounded,
      AlertType.highUsage => Icons.trending_up_rounded,
      AlertType.budget => Icons.savings_rounded,
      AlertType.device => Icons.router_rounded,
      AlertType.billing => Icons.receipt_long_rounded,
      AlertType.notice => Icons.campaign_rounded,
    };

Color severityColor(AlertSeverity s) => switch (s) {
      AlertSeverity.critical => AppColors.danger,
      AlertSeverity.warning => AppColors.warning,
      AlertSeverity.info => AppColors.primary,
    };

void showMessage(BuildContext context, String text, {bool error = false}) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(
      content: Text(text),
      backgroundColor: error ? AppColors.danger : AppColors.surfaceHigh,
    ));
}
