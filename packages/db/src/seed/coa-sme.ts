import type { AccountType, NormalBalance } from '@acct/domain';

export interface SeedAccount {
  code: string;
  name: string;
  nameAr: string;
  type: AccountType;
  subtype: string | null;
  parent: string | null;
  isBank?: boolean;
  isControlAccount?: boolean;
}

export function normalBalanceFor(type: AccountType): NormalBalance {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

/**
 * A general SME chart of accounts. Parents are inserted before their children
 * and are demoted to non-postable automatically by the accounts trigger.
 */
export const SME_COA: readonly SeedAccount[] = [
  // Assets
  { code: '1000', name: 'Assets', nameAr: 'الأصول', type: 'asset', subtype: null, parent: null },
  { code: '1100', name: 'Current Assets', nameAr: 'الأصول المتداولة', type: 'asset', subtype: 'current_asset', parent: '1000' },
  { code: '1110', name: 'Cash on Hand', nameAr: 'النقد في الصندوق', type: 'asset', subtype: 'cash', parent: '1100' },
  { code: '1120', name: 'Bank — Current Account', nameAr: 'البنك — الحساب الجاري', type: 'asset', subtype: 'bank', parent: '1100', isBank: true },
  { code: '1130', name: 'Accounts Receivable', nameAr: 'الذمم المدينة', type: 'asset', subtype: 'receivable', parent: '1100', isControlAccount: true },
  { code: '1140', name: 'Allowance for Doubtful Accounts', nameAr: 'مخصص الديون المشكوك فيها', type: 'asset', subtype: 'receivable', parent: '1100' },
  { code: '1150', name: 'Inventory', nameAr: 'المخزون', type: 'asset', subtype: 'inventory', parent: '1100', isControlAccount: true },
  { code: '1160', name: 'Prepaid Expenses', nameAr: 'مصاريف مدفوعة مقدماً', type: 'asset', subtype: 'prepaid', parent: '1100' },
  { code: '1170', name: 'Input Tax Recoverable', nameAr: 'ضريبة المدخلات القابلة للاسترداد', type: 'asset', subtype: 'tax_receivable', parent: '1100' },
  { code: '1200', name: 'Non-Current Assets', nameAr: 'الأصول غير المتداولة', type: 'asset', subtype: 'fixed_asset', parent: '1000' },
  { code: '1210', name: 'Property, Plant and Equipment', nameAr: 'الممتلكات والآلات والمعدات', type: 'asset', subtype: 'fixed_asset', parent: '1200' },
  { code: '1220', name: 'Accumulated Depreciation', nameAr: 'مجمع الاستهلاك', type: 'asset', subtype: 'accumulated_depreciation', parent: '1200' },

  // Liabilities
  { code: '2000', name: 'Liabilities', nameAr: 'الالتزامات', type: 'liability', subtype: null, parent: null },
  { code: '2100', name: 'Current Liabilities', nameAr: 'الالتزامات المتداولة', type: 'liability', subtype: 'current_liability', parent: '2000' },
  { code: '2110', name: 'Accounts Payable', nameAr: 'الذمم الدائنة', type: 'liability', subtype: 'payable', parent: '2100', isControlAccount: true },
  { code: '2120', name: 'Accrued Expenses', nameAr: 'مصاريف مستحقة', type: 'liability', subtype: 'accrual', parent: '2100' },
  { code: '2130', name: 'Output Tax Payable', nameAr: 'ضريبة المخرجات المستحقة', type: 'liability', subtype: 'tax_payable', parent: '2100' },
  { code: '2140', name: 'Payroll Liabilities', nameAr: 'التزامات الرواتب', type: 'liability', subtype: 'payroll', parent: '2100' },
  { code: '2150', name: 'Customer Deposits', nameAr: 'دفعات مقدمة من العملاء', type: 'liability', subtype: 'current_liability', parent: '2100' },
  { code: '2200', name: 'Non-Current Liabilities', nameAr: 'الالتزامات غير المتداولة', type: 'liability', subtype: 'long_term_liability', parent: '2000' },
  { code: '2210', name: 'Long-Term Loans', nameAr: 'قروض طويلة الأجل', type: 'liability', subtype: 'long_term_liability', parent: '2200' },

  // Equity
  { code: '3000', name: 'Equity', nameAr: 'حقوق الملكية', type: 'equity', subtype: null, parent: null },
  { code: '3010', name: 'Share Capital', nameAr: 'رأس المال', type: 'equity', subtype: 'capital', parent: '3000' },
  { code: '3020', name: 'Retained Earnings', nameAr: 'الأرباح المدورة', type: 'equity', subtype: 'retained_earnings', parent: '3000' },
  { code: '3030', name: 'Current Year Earnings', nameAr: 'أرباح السنة الحالية', type: 'equity', subtype: 'current_earnings', parent: '3000' },
  { code: '3090', name: 'Opening Balance Suspense', nameAr: 'حساب تسوية الأرصدة الافتتاحية', type: 'equity', subtype: 'suspense', parent: '3000' },

  // Revenue
  { code: '4000', name: 'Revenue', nameAr: 'الإيرادات', type: 'revenue', subtype: null, parent: null },
  { code: '4010', name: 'Sales Revenue', nameAr: 'إيرادات المبيعات', type: 'revenue', subtype: 'operating_revenue', parent: '4000' },
  { code: '4020', name: 'Service Revenue', nameAr: 'إيرادات الخدمات', type: 'revenue', subtype: 'operating_revenue', parent: '4000' },
  { code: '4030', name: 'Sales Returns and Discounts', nameAr: 'مردودات وخصومات المبيعات', type: 'revenue', subtype: 'contra_revenue', parent: '4000' },
  { code: '4900', name: 'Realised FX Gain', nameAr: 'أرباح فروقات العملة المحققة', type: 'revenue', subtype: 'other_income', parent: '4000' },

  // Expenses
  { code: '5000', name: 'Expenses', nameAr: 'المصاريف', type: 'expense', subtype: null, parent: null },
  { code: '5100', name: 'Cost of Goods Sold', nameAr: 'تكلفة البضاعة المباعة', type: 'expense', subtype: 'cogs', parent: '5000' },
  { code: '5200', name: 'Operating Expenses', nameAr: 'المصاريف التشغيلية', type: 'expense', subtype: 'operating_expense', parent: '5000' },
  { code: '5210', name: 'Salaries and Wages', nameAr: 'الرواتب والأجور', type: 'expense', subtype: 'operating_expense', parent: '5200' },
  { code: '5220', name: 'Rent', nameAr: 'الإيجار', type: 'expense', subtype: 'operating_expense', parent: '5200' },
  { code: '5230', name: 'Utilities', nameAr: 'المنافع', type: 'expense', subtype: 'operating_expense', parent: '5200' },
  { code: '5240', name: 'Telecommunications', nameAr: 'الاتصالات', type: 'expense', subtype: 'operating_expense', parent: '5200' },
  { code: '5250', name: 'Professional Fees', nameAr: 'أتعاب مهنية', type: 'expense', subtype: 'operating_expense', parent: '5200' },
  { code: '5260', name: 'Depreciation Expense', nameAr: 'مصروف الاستهلاك', type: 'expense', subtype: 'depreciation', parent: '5200' },
  { code: '5270', name: 'Bad Debt Expense', nameAr: 'مصروف الديون المعدومة', type: 'expense', subtype: 'operating_expense', parent: '5200' },
  { code: '5280', name: 'Bank Charges', nameAr: 'مصاريف بنكية', type: 'expense', subtype: 'operating_expense', parent: '5200' },
  { code: '5900', name: 'Realised FX Loss', nameAr: 'خسائر فروقات العملة المحققة', type: 'expense', subtype: 'other_expense', parent: '5000' },
];
