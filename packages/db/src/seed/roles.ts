/**
 * The standard role set. Permissions are deliberately narrow: an AR clerk
 * cannot approve a bill, and an auditor cannot write anything at all.
 */
export interface SystemRole {
  code: string;
  name: string;
  description: string;
  /** '*' means every permission in the catalogue. */
  permissions: readonly string[] | '*';
}

export const SYSTEM_ROLES: readonly SystemRole[] = [
  { code: 'admin', name: 'Administrator', description: 'Full access including user management', permissions: '*' },
  {
    code: 'accountant',
    name: 'Accountant',
    description: 'Full bookkeeping access, no user administration',
    permissions: [
      'ledger.account.read', 'ledger.account.write', 'ledger.entry.read', 'ledger.entry.draft',
      'ledger.entry.post', 'ledger.entry.reverse', 'ledger.period.close', 'report.read',
      'ar.customer.read', 'ar.customer.write', 'ar.invoice.read', 'ar.invoice.write', 'ar.payment.write',
      'ap.vendor.read', 'ap.vendor.write', 'ap.bill.read', 'ap.bill.write', 'ap.payment.write',
      'bank.read', 'bank.reconcile', 'tax.read', 'tax.write',
      'inventory.read', 'inventory.write', 'asset.read', 'asset.write',
      'budget.read', 'budget.write',
    ],
  },
  {
    code: 'ar_clerk',
    name: 'AR Clerk',
    description: 'Customers, invoices and receipts',
    permissions: [
      'ledger.account.read', 'ledger.entry.read', 'report.read',
      'ar.customer.read', 'ar.customer.write', 'ar.invoice.read', 'ar.invoice.write', 'ar.payment.write',
    ],
  },
  {
    code: 'ap_clerk',
    name: 'AP Clerk',
    description: 'Vendors and bills, but never approval',
    permissions: [
      'ledger.account.read', 'ledger.entry.read', 'report.read',
      'ap.vendor.read', 'ap.vendor.write', 'ap.bill.read', 'ap.bill.write',
    ],
  },
  {
    code: 'approver',
    name: 'Approver',
    description: 'Approves bills and payment runs',
    permissions: ['ledger.entry.read', 'report.read', 'ap.bill.read', 'ap.bill.approve', 'ap.payment.write'],
  },
  {
    code: 'auditor',
    name: 'Auditor',
    description: 'Read-only across the whole system, enforced at the database role level',
    permissions: [
      'ledger.account.read', 'ledger.entry.read', 'report.read', 'ar.customer.read', 'ar.invoice.read',
      'ap.vendor.read', 'ap.bill.read', 'bank.read', 'tax.read', 'inventory.read', 'asset.read',
      'budget.read', 'admin.audit.read', 'admin.user.read',
    ],
  },
  {
    code: 'viewer',
    name: 'Viewer',
    description: 'Reports only',
    permissions: ['ledger.account.read', 'report.read'],
  },
];
