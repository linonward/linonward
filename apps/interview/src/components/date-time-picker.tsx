"use client";

import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

type DateTimePickerProps = {
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
};

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function toLocalDate(value: string) {
  if (!value) return null;
  const [date] = value.split("T");
  if (date === undefined) return null;
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  return new Date(year, month - 1, day);
}

export function DateTimePicker({ value, onChange, invalid }: DateTimePickerProps) {
  const selectedDate = toLocalDate(value);
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => selectedDate || new Date());
  const [time, setTime] = useState(() => value.split("T")[1] || "10:00");
  const days = useMemo(() => {
    const year = visibleMonth.getFullYear();
    const month = visibleMonth.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const count = new Date(year, month + 1, 0).getDate();
    return Array.from({ length: firstDay + count }, (_, index) =>
      index < firstDay ? null : index - firstDay + 1,
    );
  }, [visibleMonth]);
  const chooseDay = (day: number) => {
    const date = `${visibleMonth.getFullYear()}-${pad(visibleMonth.getMonth() + 1)}-${pad(day)}`;
    onChange(`${date}T${time}`);
    setOpen(false);
  };
  const updateTime = (nextTime: string) => {
    setTime(nextTime);
    if (selectedDate)
      onChange(
        `${selectedDate.getFullYear()}-${pad(selectedDate.getMonth() + 1)}-${pad(selectedDate.getDate())}T${nextTime}`,
      );
  };
  const display = selectedDate
    ? `${selectedDate.getFullYear()} 年 ${selectedDate.getMonth() + 1} 月 ${selectedDate.getDate()} 日 · ${time}`
    : "选择面试日期与时间";
  return (
    <div className="date-picker">
      <button
        type="button"
        id="interviewDate"
        name="interviewDate"
        className="date-trigger"
        aria-expanded={open}
        data-invalid={invalid || undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{display}</span>
        <CalendarDays aria-hidden="true" />
      </button>
      {open && (
        <div className="date-popover">
          <div className="calendar">
            <div className="calendar-nav">
              <button
                type="button"
                onClick={() =>
                  setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1))
                }
                aria-label="上个月"
              >
                <ChevronLeft aria-hidden="true" />
              </button>
              <strong>
                {visibleMonth.getFullYear()} 年 {visibleMonth.getMonth() + 1} 月
              </strong>
              <button
                type="button"
                onClick={() =>
                  setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1))
                }
                aria-label="下个月"
              >
                <ChevronRight aria-hidden="true" />
              </button>
            </div>
            <div className="calendar-grid weekdays">
              {WEEKDAYS.map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <div className="calendar-grid">
              {days.map((day, index) =>
                day === null ? (
                  <span key={`blank-${index}`} />
                ) : (
                  <button
                    key={day}
                    type="button"
                    className={
                      selectedDate?.getDate() === day &&
                      selectedDate.getMonth() === visibleMonth.getMonth() &&
                      selectedDate.getFullYear() === visibleMonth.getFullYear()
                        ? "selected"
                        : ""
                    }
                    onClick={() => chooseDay(day)}
                  >
                    {day}
                  </button>
                ),
              )}
            </div>
          </div>
          <div className="time-panel">
            <span>面试时间</span>
            <div>
              <select
                id="interview-hour"
                name="interviewHour"
                value={time.split(":")[0]}
                onChange={(event) => updateTime(`${event.target.value}:${time.split(":")[1]}`)}
              >
                {Array.from({ length: 24 }, (_, hour) => (
                  <option key={hour} value={pad(hour)}>
                    {pad(hour)} 时
                  </option>
                ))}
              </select>
              <select
                id="interview-minute"
                name="interviewMinute"
                value={time.split(":")[1]}
                onChange={(event) => updateTime(`${time.split(":")[0]}:${event.target.value}`)}
              >
                {["00", "15", "30", "45"].map((minute) => (
                  <option key={minute} value={minute}>
                    {minute} 分
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="today-button"
              onClick={() => {
                const today = new Date();
                setVisibleMonth(today);
                chooseDay(today.getDate());
              }}
            >
              今天
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
