// Расчёт сроков по рабочим дням (пн–пт).
//
// «48 часов в рабочие дни»: часы отсчитываются только в рабочие дни; в выходные
// (сб/вс) время не убывает, поэтому срок переносится за выходные.
// Пример: эскалация в пятницу вечером → срок наступает во вторник вечером.

export const addWorkingHours = (from: Date, hours: number): Date => {
  const result = new Date(from)
  let remaining = Math.max(0, Math.round(hours))
  while (remaining > 0) {
    result.setHours(result.getHours() + 1)
    const day = result.getDay() // 0 = воскресенье, 6 = суббота
    if (day !== 0 && day !== 6) remaining -= 1
  }
  return result
}

// Крайний срок ответа менеджера от момента эскалации (по умолчанию 48 рабочих часов)
export const escalationDueDate = (from: Date, workingHours = 48): Date =>
  addWorkingHours(from, workingHours)
