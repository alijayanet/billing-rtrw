/**
 * Service: Payroll / Gaji Karyawan
 * Mengelola pengaturan gaji, generate slip gaji, dan kalkulasi otomatis
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const attendanceSvc = require('./attendanceService');

const EMPLOYEE_TYPES = ['technician', 'cashier', 'collector'];

// ─── PAYROLL SETTINGS ────────────────────────────────────────────────────────

function getPayrollSetting(employeeType, employeeId) {
  return db.prepare(
    'SELECT * FROM payroll_settings WHERE employee_type = ? AND employee_id = ?'
  ).get(employeeType, employeeId) || null;
}

function getAllPayrollSettings() {
  return db.prepare('SELECT * FROM payroll_settings ORDER BY employee_type, employee_id').all();
}

function upsertPayrollSetting(data) {
  const existing = getPayrollSetting(data.employee_type, data.employee_id);
  if (existing) {
    return db.prepare(`
      UPDATE payroll_settings SET
        base_salary = ?, transport_allowance = ?, meal_allowance = ?,
        phone_allowance = ?, other_allowance = ?, other_allowance_note = ?,
        absence_deduction_per_day = ?, bonus_per_ticket = ?,
        commission_percentage = ?, working_days_per_month = ?,
        updated_at = (NOW_LOCAL())
      WHERE employee_type = ? AND employee_id = ?
    `).run(
      parseInt(data.base_salary) || 0,
      parseInt(data.transport_allowance) || 0,
      parseInt(data.meal_allowance) || 0,
      parseInt(data.phone_allowance) || 0,
      parseInt(data.other_allowance) || 0,
      data.other_allowance_note || '',
      parseInt(data.absence_deduction_per_day) || 0,
      parseInt(data.bonus_per_ticket) || 0,
      parseFloat(data.commission_percentage) || 0,
      parseInt(data.working_days_per_month) || 26,
      data.employee_type,
      data.employee_id
    );
  } else {
    return db.prepare(`
      INSERT INTO payroll_settings (
        employee_type, employee_id,
        base_salary, transport_allowance, meal_allowance,
        phone_allowance, other_allowance, other_allowance_note,
        absence_deduction_per_day, bonus_per_ticket,
        commission_percentage, working_days_per_month
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.employee_type,
      parseInt(data.employee_id),
      parseInt(data.base_salary) || 0,
      parseInt(data.transport_allowance) || 0,
      parseInt(data.meal_allowance) || 0,
      parseInt(data.phone_allowance) || 0,
      parseInt(data.other_allowance) || 0,
      data.other_allowance_note || '',
      parseInt(data.absence_deduction_per_day) || 0,
      parseInt(data.bonus_per_ticket) || 0,
      parseFloat(data.commission_percentage) || 0,
      parseInt(data.working_days_per_month) || 26
    );
  }
}

function deletePayrollSetting(employeeType, employeeId) {
  return db.prepare(
    'DELETE FROM payroll_settings WHERE employee_type = ? AND employee_id = ?'
  ).run(employeeType, employeeId);
}

// ─── EMPLOYEE LIST ───────────────────────────────────────────────────────────

function getAllEmployees() {
  const employees = [];

  const technicians = db.prepare('SELECT id, name, phone, is_active FROM technicians WHERE is_active = 1').all();
  for (const t of technicians) {
    const setting = getPayrollSetting('technician', t.id);
    employees.push({ ...t, employee_type: 'technician', payroll: setting });
  }

  const cashiers = db.prepare('SELECT id, name, phone, is_active FROM cashiers WHERE is_active = 1').all();
  for (const c of cashiers) {
    const setting = getPayrollSetting('cashier', c.id);
    employees.push({ ...c, employee_type: 'cashier', payroll: setting });
  }

  const collectors = db.prepare('SELECT id, name, phone, is_active FROM collectors WHERE is_active = 1').all();
  for (const c of collectors) {
    const setting = getPayrollSetting('collector', c.id);
    employees.push({ ...c, employee_type: 'collector', payroll: setting });
  }

  return employees;
}

function getEmployeeName(employeeType, employeeId) {
  const table = employeeType === 'technician' ? 'technicians'
    : employeeType === 'cashier' ? 'cashiers'
    : employeeType === 'collector' ? 'collectors' : null;
  if (!table) return 'Unknown';
  const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(employeeId);
  return row ? row.name : 'Unknown';
}

function getEmployeePhone(employeeType, employeeId) {
  const table = employeeType === 'technician' ? 'technicians'
    : employeeType === 'cashier' ? 'cashiers'
    : employeeType === 'collector' ? 'collectors' : null;
  if (!table) return '';
  const row = db.prepare(`SELECT phone FROM ${table} WHERE id = ?`).get(employeeId);
  return row ? (row.phone || '') : '';
}

// ─── PERFORMANCE DATA ────────────────────────────────────────────────────────

function getTicketsResolvedCount(technicianId, month, year) {
  const monthStr = String(month).padStart(2, '0');
  const yearStr = String(year);
  const result = db.prepare(`
    SELECT COUNT(*) as cnt FROM tickets
    WHERE technician_id = ? AND status = 'resolved'
      AND strftime('%Y', updated_at) = ?
      AND strftime('%m', updated_at) = ?
  `).get(technicianId, yearStr, monthStr);
  return result ? result.cnt : 0;
}

function getCollectionAmount(collectorId, month, year) {
  const monthStr = String(month).padStart(2, '0');
  const yearStr = String(year);
  const result = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM collector_payment_requests
    WHERE collector_id = ? AND status = 'approved'
      AND strftime('%Y', created_at) = ?
      AND strftime('%m', created_at) = ?
  `).get(collectorId, yearStr, monthStr);
  return result ? result.total : 0;
}

function getAttendanceData(employeeType, employeeId, month, year) {
  const monthStr = String(month).padStart(2, '0');
  const yearStr = String(year);

  const summary = db.prepare(`
    SELECT
      COUNT(*) as total_days,
      SUM(CASE WHEN status = 'checked_out' THEN 1 ELSE 0 END) as completed_days,
      SUM(work_duration_minutes) as total_minutes,
      SUM(CASE WHEN time(check_in_time) > '08:30:00' THEN 1 ELSE 0 END) as late_days,
      SUM(CASE WHEN work_duration_minutes > 480 THEN work_duration_minutes - 480 ELSE 0 END) as overtime_minutes
    FROM attendance
    WHERE employee_type = ? AND employee_id = ?
      AND strftime('%Y', check_in_time) = ?
      AND strftime('%m', check_in_time) = ?
  `).get(employeeType, employeeId, yearStr, monthStr);

  return {
    workingDays: summary ? (summary.total_days || 0) : 0,
    completedDays: summary ? (summary.completed_days || 0) : 0,
    totalMinutes: summary ? (summary.total_minutes || 0) : 0,
    lateDays: summary ? (summary.late_days || 0) : 0,
    overtimeMinutes: summary ? (summary.overtime_minutes || 0) : 0
  };
}

// ─── PAYROLL SLIP GENERATION ─────────────────────────────────────────────────

function generateSlip(employeeType, employeeId, month, year) {
  const setting = getPayrollSetting(employeeType, employeeId);
  if (!setting) {
    throw new Error(`Pengaturan gaji belum diset untuk ${employeeType} ID ${employeeId}`);
  }

  const monthStr = String(month).padStart(2, '0');
  const yearStr = String(year);

  // Cek apakah slip sudah ada
  const existing = db.prepare(`
    SELECT id FROM payroll_slips
    WHERE employee_type = ? AND employee_id = ? AND period_month = ? AND period_year = ?
  `).get(employeeType, employeeId, month, year);

  if (existing) {
    throw new Error(`Slip gaji sudah ada untuk periode ${month}/${year}. Hapus dulu jika ingin generate ulang.`);
  }

  const employeeName = getEmployeeName(employeeType, employeeId);
  const attendance = getAttendanceData(employeeType, employeeId, month, year);

  // Cek apakah ada catatan absensi digital untuk karyawan ini di bulan tersebut
  const hasAttendanceLogs = db.prepare(`
    SELECT 1 FROM attendance 
    WHERE employee_type = ? AND employee_id = ? 
      AND strftime('%Y', check_in_time) = ? 
      AND strftime('%m', check_in_time) = ? 
    LIMIT 1
  `).get(employeeType, employeeId, yearStr, monthStr);

  let actualWorkingDays = 0;
  let absentDays = 0;
  let absenceDeduction = 0;
  let initialNote = '';

  if (!hasAttendanceLogs) {
    // Jika belum ada log absensi online/GPS, jangan potong gaji otomatis 26 hari! Set hadir penuh
    actualWorkingDays = setting.working_days_per_month || 26;
    absentDays = 0;
    absenceDeduction = 0;
    initialNote = 'Kehadiran default penuh (belum ada absensi GPS)';
  } else {
    actualWorkingDays = attendance.workingDays;
    absentDays = Math.max(0, (setting.working_days_per_month || 26) - actualWorkingDays);
    absenceDeduction = absentDays * (setting.absence_deduction_per_day || 0);
  }

  // Hitung bonus performa teknisi
  let ticketsResolved = 0;
  let ticketBonus = 0;
  if (employeeType === 'technician' && setting.bonus_per_ticket > 0) {
    ticketsResolved = getTicketsResolvedCount(employeeId, month, year);
    ticketBonus = ticketsResolved * setting.bonus_per_ticket;
  }

  // Hitung komisi kolektor (dukung % atau nominal flat per tagihan)
  let collectionAmount = 0;
  let collectionCommission = 0;
  if (employeeType === 'collector' && setting.commission_percentage > 0) {
    collectionAmount = getCollectionAmount(employeeId, month, year);
    if (setting.commission_percentage <= 100) {
      collectionCommission = Math.round(collectionAmount * (setting.commission_percentage / 100));
    } else {
      // Input pengguna berupa nominal rupiah flat (misal Rp 5.000 per tagihan)
      const invCount = db.prepare(`
        SELECT COUNT(*) as c FROM collector_payment_requests
        WHERE collector_id = ? AND status = 'approved'
          AND strftime('%Y', created_at) = ? AND strftime('%m', created_at) = ?
      `).get(employeeId, yearStr, monthStr)?.c || 0;
      collectionCommission = Math.round(invCount * setting.commission_percentage);
    }
  }

  // Hitung overtime bonus (Rp 15.000 per jam lembur)
  const overtimeHours = Math.round((attendance.overtimeMinutes / 60) * 10) / 10;
  const overtimeBonus = Math.round(overtimeHours * 15000);

  // Hitung potongan terlambat (25% dari tarif absen per hari terlambat)
  const lateDeduction = attendance.lateDays * Math.round((setting.absence_deduction_per_day || 0) * 0.25);

  // Total pendapatan
  const grossSalary = setting.base_salary
    + setting.transport_allowance
    + setting.meal_allowance
    + setting.phone_allowance
    + setting.other_allowance
    + ticketBonus
    + collectionCommission
    + overtimeBonus;

  // Total potongan
  const totalDeductions = absenceDeduction + lateDeduction;

  // Gaji bersih
  const netSalary = Math.max(0, grossSalary - totalDeductions);

  const result = db.prepare(`
    INSERT INTO payroll_slips (
      employee_type, employee_id, employee_name, period_month, period_year,
      base_salary, transport_allowance, meal_allowance, phone_allowance,
      other_allowance, other_allowance_note,
      working_days, absent_days, late_days, overtime_hours,
      total_tickets_resolved, total_collection_amount,
      ticket_bonus, collection_commission, overtime_bonus,
      absence_deduction, late_deduction, other_deduction, other_deduction_note,
      gross_salary, total_deductions, net_salary, status, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
  `).run(
    employeeType, employeeId, employeeName, month, year,
    setting.base_salary, setting.transport_allowance, setting.meal_allowance,
    setting.phone_allowance, setting.other_allowance, setting.other_allowance_note || '',
    actualWorkingDays, absentDays, attendance.lateDays, overtimeHours,
    ticketsResolved, collectionAmount,
    ticketBonus, collectionCommission, overtimeBonus,
    absenceDeduction, lateDeduction, 0, '',
    grossSalary, totalDeductions, netSalary,
    initialNote
  );

  return result.lastInsertRowid;
}

function generateAllSlips(month, year) {
  const employees = getAllEmployees();
  let generated = 0;
  let skipped = 0;
  const errors = [];

  for (const emp of employees) {
    if (!emp.payroll) {
      skipped++;
      continue;
    }
    try {
      generateSlip(emp.employee_type, emp.id, month, year);
      generated++;
    } catch (e) {
      if (e.message.includes('Slip gaji sudah ada')) {
        skipped++;
      } else {
        errors.push(`${emp.name}: ${e.message}`);
      }
    }
  }

  return { generated, skipped, errors };
}

// ─── PAYROLL SLIP CRUD ───────────────────────────────────────────────────────

function getSlipById(id) {
  return db.prepare('SELECT * FROM payroll_slips WHERE id = ?').get(id);
}

function getSlipsByPeriod(month, year) {
  return db.prepare(`
    SELECT * FROM payroll_slips
    WHERE period_month = ? AND period_year = ?
    ORDER BY employee_type, employee_name
  `).all(month, year);
}

function getSlipsByEmployee(employeeType, employeeId) {
  return db.prepare(`
    SELECT * FROM payroll_slips
    WHERE employee_type = ? AND employee_id = ?
    ORDER BY period_year DESC, period_month DESC
  `).all(employeeType, employeeId);
}

function updateSlipDeductions(id, otherDeduction, otherDeductionNote) {
  const slip = getSlipById(id);
  if (!slip) throw new Error('Slip tidak ditemukan');
  if (slip.status !== 'draft') throw new Error('Hanya slip draft yang bisa diedit');

  const od = parseInt(otherDeduction) || 0;
  const newTotalDeductions = slip.absence_deduction + slip.late_deduction + od;
  const newNetSalary = Math.max(0, slip.gross_salary - newTotalDeductions);

  return db.prepare(`
    UPDATE payroll_slips SET
      other_deduction = ?, other_deduction_note = ?,
      total_deductions = ?, net_salary = ?
    WHERE id = ?
  `).run(od, otherDeductionNote || '', newTotalDeductions, newNetSalary, id);
}

function updateSlip(id, data) {
  const slip = getSlipById(id);
  if (!slip) throw new Error('Slip tidak ditemukan');
  if (slip.status !== 'draft') throw new Error('Hanya slip berstatus draft yang dapat diedit');

  const baseSalary = (data.base_salary !== undefined && data.base_salary !== '') ? parseInt(data.base_salary, 10) : slip.base_salary;
  const transportAllowance = (data.transport_allowance !== undefined && data.transport_allowance !== '') ? parseInt(data.transport_allowance, 10) : slip.transport_allowance;
  const mealAllowance = (data.meal_allowance !== undefined && data.meal_allowance !== '') ? parseInt(data.meal_allowance, 10) : slip.meal_allowance;
  const phoneAllowance = (data.phone_allowance !== undefined && data.phone_allowance !== '') ? parseInt(data.phone_allowance, 10) : slip.phone_allowance;
  const otherAllowance = (data.other_allowance !== undefined && data.other_allowance !== '') ? parseInt(data.other_allowance, 10) : slip.other_allowance;
  const otherAllowanceNote = (data.other_allowance_note !== undefined) ? String(data.other_allowance_note) : slip.other_allowance_note;

  const workingDays = (data.working_days !== undefined && data.working_days !== '') ? parseInt(data.working_days, 10) : slip.working_days;
  const absentDays = (data.absent_days !== undefined && data.absent_days !== '') ? parseInt(data.absent_days, 10) : slip.absent_days;
  const lateDays = (data.late_days !== undefined && data.late_days !== '') ? parseInt(data.late_days, 10) : slip.late_days;
  const overtimeHours = (data.overtime_hours !== undefined && data.overtime_hours !== '') ? parseFloat(data.overtime_hours) : slip.overtime_hours;
  const overtimeBonus = (data.overtime_bonus !== undefined && data.overtime_bonus !== '') ? parseInt(data.overtime_bonus, 10) : slip.overtime_bonus;
  const ticketBonus = (data.ticket_bonus !== undefined && data.ticket_bonus !== '') ? parseInt(data.ticket_bonus, 10) : slip.ticket_bonus;
  const collectionCommission = (data.collection_commission !== undefined && data.collection_commission !== '') ? parseInt(data.collection_commission, 10) : slip.collection_commission;
  
  const absenceDeduction = (data.absence_deduction !== undefined && data.absence_deduction !== '') ? parseInt(data.absence_deduction, 10) : slip.absence_deduction;
  const lateDeduction = (data.late_deduction !== undefined && data.late_deduction !== '') ? parseInt(data.late_deduction, 10) : slip.late_deduction;
  const otherDeduction = (data.other_deduction !== undefined && data.other_deduction !== '') ? parseInt(data.other_deduction, 10) : slip.other_deduction;
  const otherDeductionNote = (data.other_deduction_note !== undefined) ? String(data.other_deduction_note) : slip.other_deduction_note;
  const notes = (data.notes !== undefined) ? String(data.notes) : slip.notes;

  const grossSalary = baseSalary + transportAllowance + mealAllowance + phoneAllowance + otherAllowance + ticketBonus + collectionCommission + overtimeBonus;
  const totalDeductions = absenceDeduction + lateDeduction + otherDeduction;
  const netSalary = Math.max(0, grossSalary - totalDeductions);

  db.prepare(`
    UPDATE payroll_slips SET
      base_salary = ?, transport_allowance = ?, meal_allowance = ?,
      phone_allowance = ?, other_allowance = ?, other_allowance_note = ?,
      working_days = ?, absent_days = ?, late_days = ?,
      overtime_hours = ?, overtime_bonus = ?,
      ticket_bonus = ?, collection_commission = ?,
      absence_deduction = ?, late_deduction = ?,
      other_deduction = ?, other_deduction_note = ?,
      gross_salary = ?, total_deductions = ?, net_salary = ?,
      notes = ?
    WHERE id = ?
  `).run(
    baseSalary, transportAllowance, mealAllowance,
    phoneAllowance, otherAllowance, otherAllowanceNote || '',
    workingDays, absentDays, lateDays,
    overtimeHours, overtimeBonus,
    ticketBonus, collectionCommission,
    absenceDeduction, lateDeduction,
    otherDeduction, otherDeductionNote || '',
    grossSalary, totalDeductions, netSalary,
    notes || '', id
  );

  return getSlipById(id);
}

function approveSlip(id) {
  const slip = getSlipById(id);
  if (!slip) throw new Error('Slip tidak ditemukan');
  if (slip.status !== 'draft') throw new Error('Hanya slip draft yang bisa di-approve');

  return db.prepare(`
    UPDATE payroll_slips SET status = 'approved', approved_at = (NOW_LOCAL()) WHERE id = ?
  `).run(id);
}

function markSlipPaid(id) {
  const slip = getSlipById(id);
  if (!slip) throw new Error('Slip tidak ditemukan');
  if (slip.status !== 'approved') throw new Error('Hanya slip yang sudah approved yang bisa ditandai paid');

  const result = db.prepare(`
    UPDATE payroll_slips SET status = 'paid', paid_at = (NOW_LOCAL()) WHERE id = ?
  `).run(id);

  // Auto Insert ke Tabel Pengeluaran (Expenses)
  try {
    db.prepare(`
      INSERT INTO expenses (date, category, amount, description, payment_method, recorded_by_name)
      VALUES (date('now', 'localtime'), 'Gaji & Tunjangan', ?, ?, 'transfer', 'Sistem (Payroll)')
    `).run(slip.net_salary, `Gaji ${slip.employee_name} (Periode ${slip.period_month}/${slip.period_year})`);
  } catch (e) {
    logger.error('Gagal mencatat expense dari slip gaji: ' + e.message);
  }

  return result;
}

function bulkApprove(month, year) {
  return db.prepare(`
    UPDATE payroll_slips SET status = 'approved', approved_at = (NOW_LOCAL())
    WHERE period_month = ? AND period_year = ? AND status = 'draft'
  `).run(month, year);
}

function bulkMarkPaid(month, year) {
  const slipsToPay = db.prepare(`SELECT * FROM payroll_slips WHERE period_month = ? AND period_year = ? AND status = 'approved'`).all(month, year);
  
  const result = db.prepare(`
    UPDATE payroll_slips SET status = 'paid', paid_at = (NOW_LOCAL())
    WHERE period_month = ? AND period_year = ? AND status = 'approved'
  `).run(month, year);

  // Auto Insert ke Tabel Pengeluaran (Expenses) untuk semua slip
  try {
    const stmt = db.prepare(`
      INSERT INTO expenses (date, category, amount, description, payment_method, recorded_by_name)
      VALUES (date('now', 'localtime'), 'Gaji & Tunjangan', ?, ?, 'transfer', 'Sistem (Payroll)')
    `);
    
    for (const slip of slipsToPay) {
      stmt.run(slip.net_salary, `Gaji ${slip.employee_name} (Periode ${slip.period_month}/${slip.period_year})`);
    }
  } catch (e) {
    logger.error('Gagal mencatat expense bulk slip gaji: ' + e.message);
  }

  return result;
}

function deleteSlip(id) {
  const slip = getSlipById(id);
  if (!slip) throw new Error('Slip tidak ditemukan');
  if (slip.status === 'paid') throw new Error('Slip yang sudah paid tidak bisa dihapus');
  return db.prepare('DELETE FROM payroll_slips WHERE id = ?').run(id);
}

function deleteSlipsByPeriod(month, year) {
  return db.prepare(`
    DELETE FROM payroll_slips
    WHERE period_month = ? AND period_year = ? AND status = 'draft'
  `).run(month, year);
}

// ─── STATISTICS ──────────────────────────────────────────────────────────────

function getPayrollSummary(month, year) {
  const result = db.prepare(`
    SELECT
      COUNT(*) as total_slips,
      SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as draft_count,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved_count,
      SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid_count,
      COALESCE(SUM(gross_salary), 0) as total_gross,
      COALESCE(SUM(total_deductions), 0) as total_deductions,
      COALESCE(SUM(net_salary), 0) as total_net
    FROM payroll_slips
    WHERE period_month = ? AND period_year = ?
  `).get(month, year);

  return result || {
    total_slips: 0, draft_count: 0, approved_count: 0, paid_count: 0,
    total_gross: 0, total_deductions: 0, total_net: 0
  };
}

function getAvailablePeriods() {
  return db.prepare(`
    SELECT DISTINCT period_month, period_year
    FROM payroll_slips
    ORDER BY period_year DESC, period_month DESC
    LIMIT 24
  `).all();
}

module.exports = {
  EMPLOYEE_TYPES,
  getPayrollSetting, getAllPayrollSettings, upsertPayrollSetting, deletePayrollSetting,
  getAllEmployees, getEmployeeName, getEmployeePhone,
  getTicketsResolvedCount, getCollectionAmount, getAttendanceData,
  generateSlip, generateAllSlips,
  getSlipById, getSlipsByPeriod, getSlipsByEmployee,
  updateSlip, updateSlipDeductions, approveSlip, markSlipPaid,
  bulkApprove, bulkMarkPaid,
  deleteSlip, deleteSlipsByPeriod,
  getPayrollSummary, getAvailablePeriods
};
