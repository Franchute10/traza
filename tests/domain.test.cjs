const test = require('node:test');
const assert = require('node:assert/strict');
const domain = require('../domain.js');

test('detail hash keeps the selected obligation and supports direct links', () => {
  assert.deepEqual(domain.resolveRoute('#detalle/OBL-109'), { page: 'detalle', detailId: 'OBL-109' });
  assert.deepEqual(domain.resolveRoute('#detalle/FC%2F2026'), { page: 'detalle', detailId: 'FC/2026' });
  assert.deepEqual(domain.resolveRoute('#detalle?id=OBL-015'), { page: 'detalle', detailId: 'OBL-015' });
  assert.deepEqual(domain.resolveRoute('#obligaciones'), { page: 'obligaciones', detailId: null });
});

test('only matching invoice and currency confirmations reduce the supplier balance', () => {
  const obligation = { id:'OBL-1', invoice:'F-1', amount:100, currency:'PEN' };
  const confirmations = [
    { id:'C1', obligationId:'OBL-1', attemptIds:['T1'], allocations:[{attemptId:'T1',amount:45}], appliedInvoice:'F-1', amount:45, currency:'PEN', state:'Registrada' },
    { id:'C2', obligationId:'OBL-1', appliedInvoice:'F-2', amount:30, currency:'PEN', state:'Registrada' },
    { id:'C3', obligationId:'OBL-1', appliedInvoice:'F-1', amount:20, currency:'USD', state:'Registrada' }
  ];
  assert.equal(domain.receivedForInvoice(obligation, confirmations), 45);
  assert.equal(domain.receivedForInvoice(obligation, confirmations, [{ confirmationId:'C1', attemptId:'T1', reducesProviderReceipt:true, amount:10, currency:'PEN' }]), 35);
});

test('commission rules prorate fixed fees and calculate percentage on confirmed principal', () => {
  assert.equal(domain.commissionAmount({ type:'percentage', value:2.5 }, 400, 1000), 10);
  assert.equal(domain.commissionAmount({ type:'fixed', value:30 }, 500, 1000), 15);
  assert.equal(domain.commissionAmount({ type:'fixed', value:30 }, 1400, 1000), 30);
});

test('a returned attempt without supplier confirmation creates no principal due', () => {
  const statement = domain.buildIntermediaryStatement('Juan', {
    obligations:[{ id:'O1', invoice:'F1' }],
    assignments:[{ id:'A1', obligationId:'O1', intermediary:'Juan', amount:15, currency:'PEN', state:'En curso' }],
    attempts:[{ id:'T1', obligationId:'O1', assignmentId:'A1', intermediary:'Juan', amount:15, currency:'PEN', sourceOfFunds:'Fondos propios' }],
    confirmations:[],
    returns:[{ id:'R1', attemptId:'T1', amount:15, currency:'PEN', destination:'Ordenante (intermediario)', reducesProviderReceipt:false }],
    settlements:[]
  });
  assert.equal(statement[0].confirmedPrincipal, 0);
  assert.equal(statement[0].principalDue, 0);
  assert.equal(statement[0].advanceOutstanding, 0);
});

test('an advance sent to an intermediary remains outstanding after a return to that intermediary', () => {
  const statement = domain.buildIntermediaryStatement('Juan', {
    obligations:[{ id:'O2', invoice:'F2' }],
    assignments:[{ id:'A2', obligationId:'O2', intermediary:'Juan', amount:320, currency:'PEN', state:'En curso' }],
    attempts:[{ id:'T2', obligationId:'O2', assignmentId:'A2', intermediary:'Juan', amount:320, currency:'PEN', sourceOfFunds:'Anticipo empresa', advanceAppliedAmount:320 }],
    confirmations:[],
    returns:[{ id:'R2', attemptId:'T2', amount:320, currency:'PEN', destination:'Ordenante (intermediario)', reducesProviderReceipt:false }],
    settlements:[{ id:'S2', intermediary:'Juan', obligationId:'O2', type:'Anticipo', amount:320, currency:'PEN', state:'Confirmada por el intermediario' }]
  });
  assert.equal(statement[0].confirmedPrincipal, 0);
  assert.equal(statement[0].principalDue, 0);
  assert.equal(statement[0].advanceOutstanding, 320);
  assert.equal(statement[0].movements.find(x => x.id==='R2').type, 'Devolución al intermediario');
});

test('own-funded confirmed principal is reduced by paid abonos and commissions stay separate', () => {
  const statement = domain.buildIntermediaryStatement('Juan', {
    obligations:[{ id:'O3', invoice:'F3', currency:'PEN' }],
    assignments:[{ id:'A3', obligationId:'O3', intermediary:'Juan', amount:1000, currency:'PEN', state:'En curso', commissionRule:{ type:'percentage', value:2 } }],
    attempts:[{ id:'T3', obligationId:'O3', assignmentId:'A3', intermediary:'Juan', amount:600, currency:'PEN', sourceOfFunds:'Fondos propios' }],
    confirmations:[{ id:'C3', obligationId:'O3', attemptIds:['T3'], allocations:[{ attemptId:'T3', amount:600 }], amount:600, currency:'PEN', appliedInvoice:'F3', state:'Registrada' }],
    returns:[],
    settlements:[{ id:'S3', intermediary:'Juan', type:'Reembolso', amount:200, currency:'PEN', state:'Enviada' }]
  });
  assert.equal(statement[0].confirmedPrincipal, 600);
  assert.equal(statement[0].ownFundedPrincipal, 600);
  assert.equal(statement[0].principalDue, 400);
  assert.equal(statement[0].commissionEarned, 12);
  assert.equal(statement[0].commissionDue, 12);
  assert.equal(statement[0].totalDue, 412);
});

test('currencies remain separate in intermediary statements', () => {
  const statement = domain.buildIntermediaryStatement('Juan', {
    obligations:[{ id:'O4', invoice:'F4', currency:'PEN' }, { id:'O5', invoice:'F5', currency:'USD' }],
    assignments:[
      { id:'A4', obligationId:'O4', intermediary:'Juan', amount:100, currency:'PEN', state:'En curso' },
      { id:'A5', obligationId:'O5', intermediary:'Juan', amount:50, currency:'USD', state:'En curso' }
    ],
    attempts:[
      { id:'T4', obligationId:'O4', assignmentId:'A4', intermediary:'Juan', amount:100, currency:'PEN', sourceOfFunds:'Fondos propios' },
      { id:'T5', obligationId:'O5', assignmentId:'A5', intermediary:'Juan', amount:50, currency:'USD', sourceOfFunds:'Fondos propios' }
    ],
    confirmations:[
      { id:'C4', obligationId:'O4', attemptIds:['T4'], amount:100, currency:'PEN', appliedInvoice:'F4' },
      { id:'C5', obligationId:'O5', attemptIds:['T5'], amount:50, currency:'USD', appliedInvoice:'F5' }
    ],
    returns:[], settlements:[]
  });
  assert.deepEqual(statement.map(x => x.currency), ['PEN','USD']);
  assert.deepEqual(statement.map(x => x.totalDue), [100,50]);
});
test('confirmed payment uses only the documented advance and attributes the remainder to own funds', () => {
  const statement = domain.buildIntermediaryStatement('Juan', {
    obligations:[{ id:'O6', invoice:'F6', currency:'PEN' }],
    assignments:[{ id:'A6', obligationId:'O6', intermediary:'Juan', amount:10000, currency:'PEN', state:'En curso' }],
    attempts:[{ id:'T6', obligationId:'O6', assignmentId:'A6', intermediary:'Juan', amount:10000, currency:'PEN', sourceOfFunds:'Anticipo empresa', advanceAppliedAmount:10000 }],
    confirmations:[{ id:'C6', obligationId:'O6', attemptIds:['T6'], allocations:[{attemptId:'T6',amount:10000}], amount:10000, currency:'PEN', appliedInvoice:'F6' }],
    returns:[],
    settlements:[{ id:'S6', intermediary:'Juan', obligationId:'O6', type:'Anticipo', amount:6500, currency:'PEN', state:'Confirmada por el intermediario' }]
  });
  assert.equal(statement[0].advanceApplied, 6500);
  assert.equal(statement[0].ownFundedPrincipal, 3500);
  assert.equal(statement[0].principalDue, 3500);
});

test('partial reversals reduce only their linked provider confirmation and preserve the movement trail', () => {
  const statement = domain.buildIntermediaryStatement('Juan', {
    obligations:[{ id:'O7', invoice:'F7', currency:'PEN' }],
    assignments:[{ id:'A7', obligationId:'O7', intermediary:'Juan', amount:100, currency:'PEN', state:'En curso' }],
    attempts:[{ id:'T7', obligationId:'O7', assignmentId:'A7', intermediary:'Juan', amount:100, currency:'PEN', sourceOfFunds:'Fondos propios' }],
    confirmations:[{ id:'C7', obligationId:'O7', attemptIds:['T7'], allocations:[{attemptId:'T7',amount:100}], amount:100, currency:'PEN', appliedInvoice:'F7' }],
    returns:[
      { id:'R7A', attemptId:'T7', confirmationId:'C7', amount:25, currency:'PEN', destination:'Ordenante (intermediario)', reducesProviderReceipt:true },
      { id:'R7B', attemptId:'T7', confirmationId:'C7', amount:15, currency:'PEN', destination:'Ordenante (intermediario)', reducesProviderReceipt:true }
    ],
    settlements:[]
  });
  assert.equal(statement[0].confirmedPrincipal, 60);
  assert.equal(statement[0].principalDue, 60);
  assert.equal(statement[0].movements.filter(x => x.id === 'R7A' || x.id === 'R7B').length, 2);
  assert.equal(statement[0].movements.at(-1).balanceAfter, 60);
});

test('pending reimbursements are visible but do not reduce the intermediary balance', () => {
  const statement = domain.buildIntermediaryStatement('Juan', {
    obligations:[{ id:'O8', invoice:'F8', currency:'PEN' }],
    assignments:[{ id:'A8', obligationId:'O8', intermediary:'Juan', amount:100, currency:'PEN', state:'En curso' }],
    attempts:[{ id:'T8', obligationId:'O8', assignmentId:'A8', intermediary:'Juan', amount:100, currency:'PEN' }],
    confirmations:[{ id:'C8', obligationId:'O8', attemptIds:['T8'], allocations:[{attemptId:'T8',amount:100}], amount:100, currency:'PEN', appliedInvoice:'F8' }],
    returns:[],
    settlements:[{ id:'S8', intermediary:'Juan', type:'Abono al principal', amount:40, currency:'PEN', state:'Pendiente' }]
  });
  assert.equal(statement[0].principalDue, 100);
  const movement = statement[0].movements.find(x => x.id === 'S8');
  assert.equal(movement.amount, 40);
  assert.equal(movement.impact, 0);
  assert.equal(movement.balanceAfter, 100);
});

test('shared supplier confirmation keeps partial reversals isolated to the exact attempt, confirmation and currency', () => {
  const obligation = { id:'O9', invoice:'F9', amount:100, currency:'PEN' };
  const assignments = [{ id:'A9', obligationId:'O9', intermediary:'Juan', amount:100, currency:'PEN', state:'En curso' }];
  const attempts = [
    { id:'T9A', obligationId:'O9', assignmentId:'A9', intermediary:'Juan', amount:60, currency:'PEN', sourceOfFunds:'Fondos propios' },
    { id:'T9B', obligationId:'O9', assignmentId:'A9', intermediary:'Juan', amount:40, currency:'PEN', sourceOfFunds:'Fondos propios' }
  ];
  const confirmations = [{
    id:'C9', obligationId:'O9', attemptIds:['T9A','T9B'],
    allocations:[{attemptId:'T9A',amount:60},{attemptId:'T9B',amount:40}],
    amount:100, currency:'PEN', appliedInvoice:'F9', state:'Registrada'
  }];
  const returns = [
    { id:'R9A1', confirmationId:'C9', attemptId:'T9A', amount:10, currency:'PEN', reducesProviderReceipt:true, date:'2026-01-01T10:00:00Z' },
    { id:'R9A2', confirmationId:'C9', attemptId:'T9A', amount:5, currency:'PEN', reducesProviderReceipt:true, date:'2026-01-01T10:01:00Z' },
    { id:'R9B1', confirmationId:'C9', attemptId:'T9B', amount:20, currency:'PEN', reducesProviderReceipt:true, date:'2026-01-01T10:02:00Z' },
    { id:'R9WrongAttempt', confirmationId:'C9', attemptId:'T9A', amount:30, currency:'USD', reducesProviderReceipt:true },
    { id:'R9WrongConfirmation', confirmationId:'OTHER', attemptId:'T9B', amount:30, currency:'PEN', reducesProviderReceipt:true },
    { id:'R9NotReceipt', confirmationId:'C9', attemptId:'T9B', amount:30, currency:'PEN', reducesProviderReceipt:false }
  ];

  assert.equal(domain.reversedForAllocation(confirmations[0], 'T9A', returns), 15);
  assert.equal(domain.reversedForAllocation(confirmations[0], 'T9B', returns), 20);
  assert.equal(domain.receivedForInvoice(obligation, confirmations, returns), 65);
  assert.equal(domain.assignedOpenForInvoice(obligation, assignments, attempts, confirmations, returns), 35);
  assert.equal(domain.assignmentAvailableForInvoice(obligation, assignments, attempts, confirmations, returns), 0);
  const statement = domain.buildIntermediaryStatement('Juan', { obligations:[obligation], assignments, attempts, confirmations, returns, settlements:[] });
  assert.equal(statement[0].confirmedPrincipal, 65);
  assert.equal(statement[0].principalDue, 65);
});

test('advances for one intermediary and currency remain linked to their individual invoices', () => {
  const data = {
    obligations:[{ id:'O10', invoice:'F10', amount:60, currency:'PEN' }, { id:'O11', invoice:'F11', amount:40, currency:'PEN' }],
    assignments:[
      { id:'A10', obligationId:'O10', intermediary:'Juan', amount:60, currency:'PEN', state:'En curso' },
      { id:'A11', obligationId:'O11', intermediary:'Juan', amount:40, currency:'PEN', state:'En curso' }
    ],
    attempts:[
      { id:'T10', obligationId:'O10', assignmentId:'A10', intermediary:'Juan', amount:60, currency:'PEN', sourceOfFunds:'Anticipo empresa', date:'2026-01-01' },
      { id:'T11', obligationId:'O11', assignmentId:'A11', intermediary:'Juan', amount:40, currency:'PEN', sourceOfFunds:'Anticipo empresa', date:'2026-01-02' }
    ],
    confirmations:[
      { id:'C10', obligationId:'O10', attemptIds:['T10'], allocations:[{attemptId:'T10',amount:60}], amount:60, currency:'PEN', appliedInvoice:'F10', state:'Registrada' },
      { id:'C11', obligationId:'O11', attemptIds:['T11'], allocations:[{attemptId:'T11',amount:40}], amount:40, currency:'PEN', appliedInvoice:'F11', state:'Registrada' }
    ],
    returns:[],
    settlements:[
      { id:'S10', intermediary:'Juan', obligationId:'O10', type:'Anticipo', amount:60, currency:'PEN', state:'Confirmada por el intermediario' },
      { id:'S11', intermediary:'Juan', obligationId:'O11', type:'Anticipo', amount:40, currency:'PEN', state:'Confirmada por el intermediario' }
    ]
  };
  const statement = domain.buildIntermediaryStatement('Juan', data)[0];
  assert.equal(statement.advanceDelivered, 100);
  assert.equal(statement.advanceApplied, 100);
  assert.equal(statement.advanceCommitted, 0);
  assert.equal(statement.advanceOutstanding, 0);
  assert.equal(statement.ownFundedPrincipal, 0);
  assert.deepEqual(statement.movements.filter(x => x.type==='Anticipo aplicado a pago confirmado').map(x => [x.invoice,x.attemptId,x.amount]), [['F10','T10',-60],['F11','T11',-40]]);
});

test('one advance cannot be committed to two open attempts', () => {
  const statement = domain.buildIntermediaryStatement('Juan', {
    obligations:[{ id:'O12', invoice:'F12', amount:200, currency:'PEN' }],
    assignments:[{ id:'A12', obligationId:'O12', intermediary:'Juan', amount:200, currency:'PEN', state:'En curso' }],
    attempts:[
      { id:'T12A', obligationId:'O12', assignmentId:'A12', intermediary:'Juan', amount:100, currency:'PEN', sourceOfFunds:'Anticipo empresa', date:'2026-01-01' },
      { id:'T12B', obligationId:'O12', assignmentId:'A12', intermediary:'Juan', amount:100, currency:'PEN', sourceOfFunds:'Anticipo empresa', date:'2026-01-02' }
    ],
    confirmations:[], returns:[],
    settlements:[{ id:'S12', intermediary:'Juan', obligationId:'O12', type:'Anticipo', amount:100, currency:'PEN', state:'Confirmada por el intermediario' }]
  })[0];
  assert.equal(statement.advanceDelivered, 100);
  assert.equal(statement.advanceApplied, 0);
  assert.equal(statement.advanceCommitted, 100);
  assert.equal(statement.advanceOutstanding, 0);
});

test('provider reversal after an intermediary reimbursement creates a recoverable credit', () => {
  const statement = domain.buildIntermediaryStatement('Juan', {
    obligations:[{ id:'O13', invoice:'F13', amount:100, currency:'PEN' }],
    assignments:[{ id:'A13', obligationId:'O13', intermediary:'Juan', amount:100, currency:'PEN', state:'En curso' }],
    attempts:[{ id:'T13', obligationId:'O13', assignmentId:'A13', intermediary:'Juan', amount:100, currency:'PEN', sourceOfFunds:'Fondos propios' }],
    confirmations:[{ id:'C13', obligationId:'O13', attemptIds:['T13'], allocations:[{attemptId:'T13',amount:100}], amount:100, currency:'PEN', appliedInvoice:'F13', state:'Registrada', date:'2026-01-01T10:00:00Z' }],
    returns:[{ id:'R13', attemptId:'T13', confirmationId:'C13', amount:40, currency:'PEN', destination:'Ordenante (intermediario)', reducesProviderReceipt:true, date:'2026-01-03T10:00:00Z' }],
    settlements:[{ id:'S13', intermediary:'Juan', obligationId:'O13', attemptIds:['T13'], type:'Reembolso', amount:100, currency:'PEN', state:'Confirmada por el intermediario', date:'2026-01-02T10:00:00Z' }]
  })[0];
  assert.equal(statement.confirmedPrincipal, 60);
  assert.equal(statement.principalAbonos, 100);
  assert.equal(statement.principalDue, -40);
  assert.equal(statement.totalDue, -40);
  assert.equal(statement.recoverableFromIntermediary, 40);
  assert.equal(statement.movements.find(x => x.id==='R13').balanceAfter, -40);
});

test('a full provider return sent to the intermediary recovers both the advance and paid reimbursement', () => {
  const statement = domain.buildIntermediaryStatement('Juan', {
    obligations:[{ id:'O15', invoice:'F15', amount:100, currency:'PEN' }],
    assignments:[{ id:'A15', obligationId:'O15', intermediary:'Juan', amount:100, currency:'PEN', state:'En curso' }],
    attempts:[{ id:'T15', obligationId:'O15', assignmentId:'A15', intermediary:'Juan', amount:100, currency:'PEN', sourceOfFunds:'Anticipo empresa', advanceAppliedAmount:60, advanceSettlementIds:['ADV15'], state:'Confirmado totalmente', date:'2026-01-01T09:00:00Z' }],
    confirmations:[{ id:'C15', obligationId:'O15', attemptIds:['T15'], allocations:[{attemptId:'T15',amount:100}], amount:100, currency:'PEN', appliedInvoice:'F15', state:'Registrada', date:'2026-01-02T10:00:00Z' }],
    returns:[{ id:'RET15', attemptId:'T15', confirmationId:'C15', amount:100, currency:'PEN', reducesProviderReceipt:true, destination:'Ordenante (intermediario)', date:'2026-01-04T10:00:00Z' }],
    settlements:[
      { id:'ADV15', intermediary:'Juan', obligationId:'O15', attemptIds:['T15'], type:'Anticipo', amount:60, currency:'PEN', state:'Confirmada por el intermediario', date:'2026-01-01T08:00:00Z' },
      { id:'REIMB15', intermediary:'Juan', obligationId:'O15', attemptIds:['T15'], type:'Reembolso', amount:40, currency:'PEN', state:'Enviada', date:'2026-01-03T11:00:00Z' }
    ]
  })[0];

  assert.equal(statement.totalDue, -40, 'the 40 PEN reimbursement is recoverable, not payable');
  assert.equal(statement.advanceOutstanding, 60);
  assert.equal(statement.principalDue, -40);
  assert.equal(statement.principalRecoverable, 40);
  assert.equal(statement.recoverableFromIntermediary, 40);
  assert.equal(statement.totalRecoverableOrRegularize, 100);
  const providerReturn = statement.movements.find(x => x.id==='RET15');
  assert.equal(providerReturn.amount, -100);
  assert.equal(providerReturn.balanceAfter, -100);
  assert.equal(providerReturn.attemptId, 'T15');
  assert.equal(providerReturn.confirmationId, 'C15');
});

test('local persistence reports quota failures without changing the caller data', () => {
  const data = { attempts:[{ id:'T14' }] };
  const failingStorage = { setItem() { throw new Error('QuotaExceededError'); } };
  assert.equal(domain.persistLocalData(failingStorage, 'traza', data), false);
  assert.deepEqual(data, { attempts:[{ id:'T14' }] });

  let saved = null;
  const workingStorage = { setItem(key, value) { saved = [key, value]; } };
  assert.equal(domain.persistLocalData(workingStorage, 'traza', data), true);
  assert.equal(saved[0], 'traza');
  assert.deepEqual(JSON.parse(saved[1]), data);
});
