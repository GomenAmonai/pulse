import { Monitor, Moon, Sun } from "lucide-react";
import { motion } from "motion/react";

import { useTheme, type Theme } from "../lib/theme";

const OPTIONS: { value: Theme; icon: typeof Sun; label: string }[] = [
  { value: "system", icon: Monitor, label: "System theme" },
  { value: "light", icon: Sun, label: "Light theme" },
  { value: "dark", icon: Moon, label: "Dark theme" },
];

export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="flex items-center rounded-full border border-border p-0.5" role="radiogroup" aria-label="Theme">
      {OPTIONS.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
          className={`pressable relative grid size-7 place-items-center rounded-full ${theme === value ? "text-text" : "text-subtle hover:text-text"}`}
        >
          {theme === value && (
            <motion.span
              layoutId="theme-pill"
              className="absolute inset-0 rounded-full bg-surface-3"
              transition={{ type: "spring", bounce: 0, duration: 0.3 }}
            />
          )}
          <Icon className="relative size-3.5" />
        </button>
      ))}
    </div>
  );
}
