/* Core rules shared by the browser app and the built-in Node test suite. */
(function attachTrazaDomain(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TrazaDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTrazaDomain() {
  const PAID_STATES = new Set(['Enviada', 'Confirmada por el intermediario', 'Confirmada por la empresa', 'Conciliada']);
  const APPROVED_STATES = new Set(['Confirmada por el intermediario', 'Confirmada por la empresa', 'Conciliada']);

  function resolveRoute(hash = '', search = '') {
    const raw = String(hash || '').replace(/^#/, '');
    const splitAt = raw.indexOf('?');
    const path = splitAt >= 0 ? raw.slice(0, splitAt) : raw;
    const hashQuery = splitAt >= 0 ? raw.slice(splitAt + 1) : '';
    const query = new URLSearchParams(hashQuery || String(search || '').replace(/^\?/, ''));
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'detalle') {
      let detailId = parts[1] || query.get('id') || null;
      if (detailId) {
        try { detailId = decodeURIComponent(detailId); } catch { /* keep the literal route token */ }
      }
      return { page: 'detalle', detailId };
    }
    return { page: parts[0] || 'inicio', detailId: null };
  }

  function allocationFor(confirmation, attemptId) {
    if (Array.isArray(confirmation.allocations)) {
      return confirmation.allocations.filter(x => x.attemptId === attemptId).reduce((sum, x) => sum + Number(x.amount || 0), 0);
    }
    const attemptIds = confirmation.attemptIds || [];
    // Legacy single-attempt records are unambiguous. Shared confirmations need
    // explicit allocations so one return cannot consume another attempt's share.
    if (attemptIds.length === 1 && attemptIds[0] === attemptId) return Number(confirmation.amount || 0);
    return 0;
  }

  function confirmationsForAttempt(attemptId, confirmations = []) {
    return confirmations.filter(c => allocationFor(c, attemptId) > 0);
  }

  function reversalsForAllocation(confirmation, attemptId, returns = []) {
    const allocation = Math.max(0, allocationFor(confirmation, attemptId));
    if (!allocation) return [];
    const linked = returns
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.confirmationId === confirmation.id
        && row.attemptId === attemptId
        && row.currency === confirmation.currency
        && row.reducesProviderReceipt === true)
      .sort((a, b) => new Date(a.row.date || 0) - new Date(b.row.date || 0) || a.index - b.index);
    let available = allocation;
    return linked.map(({ row }) => {
      const amount = Math.max(0, Number(row.amount || 0));
      const appliedAmount = Math.min(available, amount);
      available -= appliedAmount;
      return { returnId: row.id, attemptId, confirmationId: confirmation.id, amount, appliedAmount, excessAmount: amount - appliedAmount };
    });
  }

  function reversedForAllocation(confirmation, attemptId, returns = []) {
    return reversalsForAllocation(confirmation, attemptId, returns).reduce((sum, row) => sum + row.appliedAmount, 0);
  }

  function netConfirmedForAttempt(confirmation, attemptId, returns = []) {
    return Math.max(0, allocationFor(confirmation, attemptId) - reversedForAllocation(confirmation, attemptId, returns));
  }

  function receivedForInvoice(obligation, confirmations = [], returns = []) {
    const valid = confirmations.filter(c => c.obligationId === obligation.id && c.state !== 'Anulada' && c.appliedInvoice === obligation.invoice && c.currency === obligation.currency);
    return valid.reduce((sum, confirmation) => {
      const attemptIds = Array.isArray(confirmation.allocations)
        ? [...new Set(confirmation.allocations.map(row => row.attemptId).filter(Boolean))]
        : (confirmation.attemptIds || []).length === 1 ? confirmation.attemptIds : [];
      const reversed = attemptIds.reduce((subtotal, attemptId) => subtotal + reversedForAllocation(confirmation, attemptId, returns), 0);
      return sum + Math.max(0, Number(confirmation.amount || 0) - reversed);
    }, 0);
  }

  function assignedOpenForInvoice(obligation, assignments = [], attempts = [], confirmations = [], returns = []) {
    if (!obligation) return 0;
    return assignments
      .filter(assignment => assignment.obligationId === obligation.id
        && assignment.currency === obligation.currency
        && !['Rechazada', 'Cancelada', 'Borrador', 'Completada', 'Cerrada por devolución'].includes(assignment.state))
      .reduce((sum, assignment) => {
        const confirmed = attempts
          .filter(attempt => attempt.assignmentId === assignment.id && attempt.obligationId === obligation.id)
          .reduce((subtotal, attempt) => subtotal + confirmations
            .filter(confirmation => confirmation.obligationId === obligation.id
              && confirmation.appliedInvoice === obligation.invoice
              && confirmation.currency === obligation.currency
              && confirmation.state !== 'Anulada')
            .reduce((attemptTotal, confirmation) => attemptTotal + netConfirmedForAttempt(confirmation, attempt.id, returns), 0), 0);
        return sum + Math.max(0, Number(assignment.amount || 0) - confirmed);
      }, 0);
  }

  function assignmentAvailableForInvoice(obligation, assignments = [], attempts = [], confirmations = [], returns = []) {
    if (!obligation) return 0;
    const confirmed = receivedForInvoice(obligation, confirmations, returns);
    const assignedOpen = assignedOpenForInvoice(obligation, assignments, attempts, confirmations, returns);
    return Math.max(0, Number(obligation.amount || 0) - confirmed - assignedOpen);
  }

  function persistLocalData(storage, key, data) {
    try {
      storage.setItem(key, JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }

  function commissionAmount(rule, confirmedAmount, assignedAmount) {
    if (!rule || Number(confirmedAmount) <= 0) return 0;
    const base = Math.max(0, Number(confirmedAmount) || 0);
    const assigned = Math.max(0, Number(assignedAmount) || 0);
    if (rule.type === 'percentage') return Math.round(base * Math.max(0, Number(rule.value) || 0)) / 100;
    if (rule.type === 'fixed') {
      const fixed = Math.max(0, Number(rule.value) || 0);
      return assigned ? fixed * Math.min(1, base / assigned) : 0;
    }
    return 0;
  }

  function buildIntermediaryStatement(intermediary, data) {
    const assignments = (data.assignments || []).filter(a => a.intermediary === intermediary && a.state !== 'Rechazada' && a.state !== 'Cancelada');
    const assignmentById = new Map(assignments.map(a => [a.id, a]));
    const attempts = (data.attempts || []).filter(a => a.intermediary === intermediary && assignmentById.has(a.assignmentId));
    const confirmations = data.confirmations || [];
    const returns = data.returns || [];
    const settlements = (data.settlements || []).filter(s => s.intermediary === intermediary);
    const rowsByCurrency = new Map();
    const ensure = currency => {
      if (!rowsByCurrency.has(currency)) rowsByCurrency.set(currency, {
        currency, confirmedPrincipal: 0, advanceDelivered: 0, advanceApplied: 0,
        advanceCommitted: 0, advanceReturned: 0, advanceOutstanding: 0, ownFundedPrincipal: 0,
        principalAbonos: 0, principalDue: 0, commissionEarned: 0,
        commissionAbonos: 0, commissionDue: 0, approvedCharges: 0,
        chargeAbonos: 0, chargesDue: 0, principalRecoverable: 0,
        commissionRecoverable: 0, chargesRecoverable: 0, recoverableFromIntermediary: 0,
        totalDue: 0, movements: []
      });
      return rowsByCurrency.get(currency);
    };
    const grossByAssignmentCurrency = new Map();
    const advanceSettlements = settlements.filter(s => s.type === 'Anticipo' && PAID_STATES.has(s.state));
    const remainingByAdvance = new Map(advanceSettlements.map(s => [s.id, Math.max(0, Number(s.amount || 0))]));
    const advanceCapByAttempt = new Map();
    const orderedAttempts = [...attempts].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    for (const attempt of orderedAttempts) {
      const assignment = assignmentById.get(attempt.assignmentId);
      if (attempt.sourceOfFunds !== 'Anticipo empresa') {
        advanceCapByAttempt.set(attempt.id, 0);
        continue;
      }
      const requestedValue = Math.max(0, Number(attempt.advanceAppliedAmount ?? attempt.amount) || 0);
      const explicitIds = attempt.advanceSettlementIds || (attempt.advanceSettlementId ? [attempt.advanceSettlementId] : null);
      const linked = advanceSettlements.filter(advance => {
        if (advance.currency !== attempt.currency) return false;
        if (explicitIds && !explicitIds.includes(advance.id)) return false;
        if (advance.assignmentId && advance.assignmentId !== assignment?.id) return false;
        if (advance.obligationId && advance.obligationId !== attempt.obligationId) return false;
        if (Array.isArray(advance.attemptIds) && advance.attemptIds.length) return advance.attemptIds.includes(attempt.id);
        return Boolean(advance.obligationId && advance.obligationId === attempt.obligationId);
      }).sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
      let needed = requestedValue;
      const claims = [];
      for (const advance of linked) {
        if (needed <= 0) break;
        const available = remainingByAdvance.get(advance.id) || 0;
        const amount = Math.min(needed, available);
        if (amount > 0) {
          claims.push({ settlementId: advance.id, amount });
          remainingByAdvance.set(advance.id, available - amount);
          needed -= amount;
        }
      }
      advanceCapByAttempt.set(attempt.id, claims.reduce((sum, claim) => sum + claim.amount, 0));
    }

    for (const attempt of attempts) {
      const assignment = assignmentById.get(attempt.assignmentId);
      const obligation = (data.obligations || []).find(o => o.id === attempt.obligationId);
      const allocations = confirmations.map(confirmation => ({ confirmation, amount: allocationFor(confirmation, attempt.id) }))
        .filter(x => x.amount > 0 && x.confirmation.state !== 'Anulada'
          && x.confirmation.appliedInvoice === obligation?.invoice
          && x.confirmation.obligationId === attempt.obligationId
          && x.confirmation.currency === attempt.currency
          && x.confirmation.currency === obligation?.currency);
      const advanceCap = Number(advanceCapByAttempt.get(attempt.id) || 0);
      const advanceRatio = attempt.amount > 0 ? Math.min(1, advanceCap / attempt.amount) : 0;
      const grossConfirmed = allocations.reduce((sum, item) => sum + item.amount, 0);
      const liveAttempt = !['Fallido', 'Cancelado', 'Devuelto o revertido', 'Rechazado'].includes(attempt.state);
      const unconfirmedReturns = returns.filter(row => row.attemptId === attempt.id
        && row.currency === attempt.currency && row.reducesProviderReceipt !== true)
        .reduce((sum, row) => sum + Number(row.amount || 0), 0);
      const committed = liveAttempt
        ? Math.max(0, advanceCap - Math.min(advanceCap, grossConfirmed) - Math.min(advanceCap, unconfirmedReturns))
        : 0;
      ensure(attempt.currency).advanceCommitted += committed;

      for (const { confirmation, amount } of allocations) {
        const currency = confirmation.currency;
        const net = netConfirmedForAttempt(confirmation, attempt.id, returns);
        const applied = Math.min(net, net * advanceRatio);
        const row = ensure(currency);
        row.confirmedPrincipal += net;
        row.advanceApplied += applied;
        row.ownFundedPrincipal += net - applied;
        const key = `${assignment.id}\u0000${currency}`;
        grossByAssignmentCurrency.set(key, (grossByAssignmentCurrency.get(key) || 0) + net);
        const grossApplied = Math.min(Number(amount), Number(attempt.amount || 0) * advanceRatio);
        const grossOwn = Math.max(0, Number(amount) - grossApplied);
        if (grossOwn > 0) row.movements.push({ id: `${confirmation.id}-OWN-${attempt.id}`, date: confirmation.date, type: 'Principal confirmado · fondos propios', amount: grossOwn, currency, reference: confirmation.reference || confirmation.evidence || '', attemptId: attempt.id, invoice: obligation?.invoice || '', evidence: confirmation.evidence || '' });
        if (grossApplied > 0) row.movements.push({ id: `${confirmation.id}-ADV-${attempt.id}`, date: confirmation.date, type: 'Anticipo aplicado a pago confirmado', amount: -grossApplied, currency, reference: confirmation.reference || confirmation.evidence || '', attemptId: attempt.id, invoice: obligation?.invoice || '', evidence: confirmation.evidence || '' });
      }

      const orderedReturns = returns.filter(row => row.attemptId === attempt.id)
        .map((row, index) => ({ row, index }))
        .sort((a, b) => new Date(a.row.date || 0) - new Date(b.row.date || 0) || a.index - b.index);
      const validReversalById = new Map();
      for (const { confirmation } of allocations) {
        for (const reversal of reversalsForAllocation(confirmation, attempt.id, returns)) {
          validReversalById.set(reversal.returnId, reversal.appliedAmount);
        }
      }
      for (const { row: reversal } of orderedReturns) {
        const linkedConfirmation = confirmations.find(confirmation => confirmation.id === reversal.confirmationId
          && confirmation.obligationId === attempt.obligationId
          && confirmation.appliedInvoice === obligation?.invoice
          && confirmation.currency === reversal.currency
          && confirmation.state !== 'Anulada'
          && allocationFor(confirmation, attempt.id) > 0);
        const appliedReversal = reversal.reducesProviderReceipt === true && linkedConfirmation
          ? Number(validReversalById.get(reversal.id) || 0)
          : 0;
        const reversed = appliedReversal > 0;
        const ownPart = appliedReversal * (1 - advanceRatio);
        const advancePart = appliedReversal * advanceRatio;
        const toIntermediary = /intermediario|ordenante/i.test(reversal.destination || '');
        const impact = reversed ? (toIntermediary ? -(ownPart + advancePart) : -ownPart) : 0;
        const reversalRow = ensure(reversal.currency);
        if (reversed && !toIntermediary) reversalRow.advanceReturned += advancePart;
        const excess = reversal.reducesProviderReceipt === true
          ? Math.max(0, Number(reversal.amount || 0) - appliedReversal)
          : 0;
        const type = excess > 0
          ? 'Devolución excedente pendiente de revisión'
          : reversal.destination === 'Ordenante (intermediario)' ? 'Devolución al intermediario' : `Devolución a ${reversal.destination}`;
        reversalRow.movements.push({ id: reversal.id, date: reversal.date, type, amount: impact, currency: reversal.currency, reference: reversal.reason || '', attemptId: attempt.id, confirmationId: linkedConfirmation?.id || '', invoice: obligation?.invoice || '', evidence: reversal.evidence || '', returnedAmount: Number(reversal.amount || 0), appliedReversal, excessAmount: excess });
      }
    }

    for (const assignment of assignments) {
      const rule = assignment.commissionRule;
      if (!rule || !rule.type || !(Number(rule.value) > 0)) continue;
      const currencies = new Set([...grossByAssignmentCurrency.keys()].filter(key => key.startsWith(`${assignment.id}\u0000`)).map(key => key.split('\u0000')[1]));
      for (const currency of currencies) {
        const confirmed = grossByAssignmentCurrency.get(`${assignment.id}\u0000${currency}`) || 0;
        const earned = commissionAmount(rule, confirmed, assignment.amount);
        if (earned > 0) {
          const row = ensure(currency);
          row.commissionEarned += earned;
          const assignmentAttemptIds = attempts.filter(attempt => attempt.assignmentId === assignment.id).map(attempt => attempt.id);
          const effectiveDate = row.movements.filter(movement => assignmentAttemptIds.includes(movement.attemptId) && movement.date)
            .map(movement => movement.date).sort().at(-1) || assignment.assignedAt;
          row.movements.push({ id: `COM-${assignment.id}-${currency}`, date: effectiveDate, type: `Comisión calculada (${rule.type === 'percentage' ? `${rule.value}%` : 'importe fijo'})`, amount: earned, currency, reference: `Base confirmada neta ${confirmed.toFixed(2)} · asignación ${assignment.id}`, attemptId: '', invoice: assignment.obligationId || '', evidence: '' });
        }
      }
    }

    for (const settlement of settlements) {
      const row = ensure(settlement.currency);
      const amount = Number(settlement.amount || 0);
      const paid = PAID_STATES.has(settlement.state);
      const approved = APPROVED_STATES.has(settlement.state);
      if (settlement.type === 'Anticipo' && paid) row.advanceDelivered += amount;
      if (['Devolución','Devolución de anticipo'].includes(settlement.type) && paid) row.advanceReturned += amount;
      if (['Reembolso','Abono al principal'].includes(settlement.type) && paid) row.principalAbonos += amount;
      if (['Abono de comisión','Pago de comisión'].includes(settlement.type) && paid) row.commissionAbonos += amount;
      if (['Cargo','Cargo aprobado'].includes(settlement.type) && approved) row.approvedCharges += amount;
      if (['Abono de cargo','Pago de cargo'].includes(settlement.type) && paid) row.chargeAbonos += amount;
      const negative = ['Devolución','Devolución de anticipo','Reembolso','Abono al principal','Abono de comisión','Pago de comisión','Abono de cargo','Pago de cargo'].includes(settlement.type);
      const impactsBalance = settlement.type === 'Anticipo' || ['Devolución','Devolución de anticipo','Reembolso','Abono al principal','Abono de comisión','Pago de comisión','Abono de cargo','Pago de cargo'].includes(settlement.type) ? paid : ['Cargo','Cargo aprobado'].includes(settlement.type) ? approved : false;
      const impact = impactsBalance ? (negative ? -amount : amount) : 0;
      row.movements.push({ id: settlement.id, date: settlement.date, type: settlement.type, amount, impact, currency: settlement.currency, reference: settlement.reference || '', attemptId: (settlement.attemptIds || [])[0] || '', invoice: settlement.obligationId || '', evidence: settlement.evidence || '', state: settlement.state, balanceBefore: settlement.balanceBefore || '', balanceAfter: settlement.balanceAfter || '' });
    }

    for (const row of rowsByCurrency.values()) {
      row.advanceApplied = Math.min(row.advanceApplied, row.advanceDelivered);
      row.advanceOutstanding = Math.max(0, row.advanceDelivered - row.advanceApplied - row.advanceCommitted - row.advanceReturned);
      row.principalDue = row.ownFundedPrincipal - row.principalAbonos;
      row.commissionDue = row.commissionEarned - row.commissionAbonos;
      row.chargesDue = row.approvedCharges - row.chargeAbonos;
      row.principalRecoverable = Math.max(0, -row.principalDue);
      row.commissionRecoverable = Math.max(0, -row.commissionDue);
      row.chargesRecoverable = Math.max(0, -row.chargesDue);
      row.totalDue = row.principalDue + row.commissionDue + row.chargesDue;
      row.recoverableFromIntermediary = Math.max(0, -row.totalDue);
      row.totalRecoverableOrRegularize = row.advanceOutstanding + row.recoverableFromIntermediary;
      row.movements.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
      let runningBalance = 0;
      for (const movement of row.movements) {
        runningBalance += Number(movement.impact ?? movement.amount ?? 0);
        movement.balanceAfter = runningBalance;
      }
    }
    return [...rowsByCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  }

  return {
    PAID_STATES, APPROVED_STATES, resolveRoute, allocationFor, confirmationsForAttempt,
    reversalsForAllocation, reversedForAllocation, netConfirmedForAttempt, receivedForInvoice,
    assignedOpenForInvoice, assignmentAvailableForInvoice, persistLocalData,
    commissionAmount, buildIntermediaryStatement
  };
});
