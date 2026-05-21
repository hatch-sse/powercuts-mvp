function dashboardMaxDate() {
  const generatedDate = parseDateOnly(String(state.payload?.generated_at || '').slice(0, 10));
  const availableEnd = parseDateOnly(state.payload?.available_end);
  if (generatedDate && availableEnd) return generatedDate > availableEnd ? generatedDate : availableEnd;
  return generatedDate || availableEnd;
}

getDateRange = function getDateRangeUsingGeneratedDate() {
  const minDate = parseDateOnly(state.payload?.available_start);
  const maxDate = dashboardMaxDate();
  let startDate = parseDateOnly(document.getElementById('startDate').value);
  let endDate = parseDateOnly(document.getElementById('endDate').value);

  if (!minDate || !maxDate) {
    const today = new Date();
    return {
      startDate: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 30)),
      endDate: today,
      endDateExclusive: addDays(today, 1),
    };
  }

  startDate = startDate || addDays(maxDate, -30);
  endDate = endDate || maxDate;
  startDate = clampDate(startDate, minDate, maxDate);
  endDate = clampDate(endDate, minDate, maxDate);

  if (startDate > endDate) {
    const temp = startDate;
    startDate = endDate;
    endDate = temp;
  }

  return { startDate, endDate, endDateExclusive: addDays(endDate, 1) };
};

setQuickRange = function setQuickRangeUsingGeneratedDate(range) {
  const minDate = parseDateOnly(state.payload?.available_start);
  const maxDate = dashboardMaxDate();
  if (!minDate || !maxDate) return;

  let startDate;
  const endDate = maxDate;
  if (range === 'ytd') startDate = new Date(Date.UTC(endDate.getUTCFullYear(), 0, 1));
  else startDate = addDays(endDate, -Number(range) + 1);

  startDate = clampDate(startDate, minDate, maxDate);
  document.getElementById('startDate').value = toDateInputValue(startDate);
  document.getElementById('endDate').value = toDateInputValue(endDate);
  updateAll();
};

initialiseDateInputs = function initialiseDateInputsUsingGeneratedDate() {
  const minDate = parseDateOnly(state.payload?.available_start);
  const maxDate = dashboardMaxDate();
  if (!minDate || !maxDate) return;

  const startInput = document.getElementById('startDate');
  const endInput = document.getElementById('endDate');
  startInput.min = toDateInputValue(minDate);
  startInput.max = toDateInputValue(maxDate);
  endInput.min = toDateInputValue(minDate);
  endInput.max = toDateInputValue(maxDate);
  startInput.value = toDateInputValue(clampDate(addDays(maxDate, -29), minDate, maxDate));
  endInput.value = toDateInputValue(maxDate);

  const note = document.getElementById('dateRangeNote');
  if (note) {
    note.textContent = `Available data: ${formatDateUK(minDate)} to ${formatDateUK(maxDate)}. Date filtering is limited to the rolling ${state.payload.rolling_days || 365} days.`;
  }
};
