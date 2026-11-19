import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/theme.dart';
import '../../data/models.dart';
import '../../state/providers.dart';
import '../../widgets/common.dart';

class TicketsScreen extends ConsumerWidget {
  const TicketsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: const Text('Complaints & support')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => showModalBottomSheet<void>(
          context: context,
          isScrollControlled: true,
          backgroundColor: AppColors.surface,
          showDragHandle: true,
          builder: (_) => const _NewTicketSheet(),
        ),
        icon: const Icon(Icons.add),
        label: const Text('New complaint'),
      ),
      body: AsyncView(
        value: ref.watch(ticketsProvider),
        onRetry: () => ref.invalidate(ticketsProvider),
        data: (tickets) => tickets.isEmpty
            ? const EmptyState(
                icon: Icons.support_agent_rounded,
                title: 'No complaints',
                message: 'Report a leak in the street, a billing problem or a meter fault.',
              )
            : PageBody(
                onRefresh: () async => ref.invalidate(ticketsProvider),
                children: [
                  for (final t in tickets) ...[_TicketCard(ticket: t), const SizedBox(height: 10)],
                  const SizedBox(height: 72),
                ],
              ),
      ),
    );
  }
}

class _TicketCard extends StatelessWidget {
  const _TicketCard({required this.ticket});

  final Ticket ticket;

  @override
  Widget build(BuildContext context) {
    final (label, color) = switch (ticket.status) {
      TicketStatus.open => ('Open', AppColors.primary),
      TicketStatus.inProgress => ('In progress', AppColors.warning),
      TicketStatus.resolved => ('Resolved', AppColors.success),
      TicketStatus.closed => ('Closed', AppColors.textMuted),
    };
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Text(ticket.id, style: const TextStyle(color: AppColors.textMuted, fontWeight: FontWeight.w600)),
            const SizedBox(width: 8),
            Text('· ${ticket.category}', style: const TextStyle(color: AppColors.textMuted)),
            const Spacer(),
            StatusPill(label: label, color: color),
          ]),
          const SizedBox(height: 8),
          Text(ticket.subject, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
          if (ticket.description.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(ticket.description, style: const TextStyle(color: AppColors.textMuted)),
          ],
          const SizedBox(height: 8),
          Text('Opened ${formatDate(ticket.createdAt)}',
              style: const TextStyle(color: AppColors.textMuted, fontSize: 12)),
        ],
      ),
    );
  }
}

class _NewTicketSheet extends ConsumerStatefulWidget {
  const _NewTicketSheet();

  @override
  ConsumerState<_NewTicketSheet> createState() => _NewTicketSheetState();
}

class _NewTicketSheetState extends ConsumerState<_NewTicketSheet> {
  static const _categories = ['Billing', 'Meter fault', 'Leak / burst pipe', 'No water supply', 'Water quality', 'Other'];
  String _category = _categories.first;
  final _subject = TextEditingController();
  final _description = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _subject.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_subject.text.trim().isEmpty) {
      showMessage(context, 'Add a short subject.', error: true);
      return;
    }
    setState(() => _busy = true);
    try {
      final t = await ref.read(repositoryProvider).createTicket(
            category: _category,
            subject: _subject.text.trim(),
            description: _description.text.trim(),
          );
      ref.invalidate(ticketsProvider);
      if (mounted) {
        Navigator.pop(context);
        showMessage(context, 'Complaint ${t.id} submitted');
      }
    } catch (e) {
      if (mounted) showMessage(context, e.toString(), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.viewInsetsOf(context).bottom + 20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('New complaint', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
          const SizedBox(height: 16),
          DropdownButtonFormField<String>(
            value: _category,
            dropdownColor: AppColors.surfaceHigh,
            decoration: const InputDecoration(labelText: 'Category'),
            items: [for (final c in _categories) DropdownMenuItem(value: c, child: Text(c))],
            onChanged: (v) => setState(() => _category = v ?? _category),
          ),
          const SizedBox(height: 12),
          TextField(controller: _subject, decoration: const InputDecoration(labelText: 'Subject')),
          const SizedBox(height: 12),
          TextField(
            controller: _description,
            maxLines: 4,
            decoration: const InputDecoration(labelText: 'Describe the problem', alignLabelWithHint: true),
          ),
          const SizedBox(height: 20),
          FilledButton(
            onPressed: _busy ? null : _submit,
            child: _busy
                ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                : const Text('Submit'),
          ),
        ],
      ),
    );
  }
}
