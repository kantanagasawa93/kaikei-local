"use client";

import { motion, AnimatePresence, useSpring, useMotionValue, useTransform } from "framer-motion";
import { useEffect, useRef, useState } from "react";

// ============================================================
// 1. フェードイン（ページ・セクション単位）
// ============================================================
export function FadeIn({
  children,
  delay = 0,
  duration = 0.4,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  duration?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration, delay, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ============================================================
// 2. スタガー（リスト・カード群）
// ============================================================
export function StaggerContainer({
  children,
  className = "",
  staggerDelay = 0.05,
}: {
  children: React.ReactNode;
  className?: string;
  staggerDelay?: number;
}) {
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={{
        visible: {
          transition: { staggerChildren: staggerDelay },
        },
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 8 },
        visible: {
          opacity: 1,
          y: 0,
          transition: { duration: 0.3, ease: "easeOut" },
        },
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ============================================================
// 3. カウントアップ（ダッシュボード数字）
// ============================================================
export function CountUp({
  target,
  duration = 1.2,
  prefix = "",
  suffix = "",
  className = "",
}: {
  target: number;
  duration?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}) {
  const motionVal = useMotionValue(0);
  const spring = useSpring(motionVal, {
    damping: 30,
    stiffness: 100,
    duration: duration * 1000,
  });
  const [display, setDisplay] = useState("0");

  useEffect(() => {
    motionVal.set(target);
  }, [target, motionVal]);

  useEffect(() => {
    const unsubscribe = spring.on("change", (v) => {
      if (Math.abs(v) >= 1000) {
        setDisplay(Math.floor(v).toLocaleString("ja-JP"));
      } else {
        setDisplay(Math.floor(v).toString());
      }
    });
    return unsubscribe;
  }, [spring]);

  return (
    <span className={className}>
      {prefix}
      {display}
      {suffix}
    </span>
  );
}

// ============================================================
// 4. 成功チェックアニメーション
// ============================================================
export function SuccessCheck({ show }: { show: boolean }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0, opacity: 0 }}
          transition={{ type: "spring", damping: 15, stiffness: 200 }}
          className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-500 text-white"
        >
          <motion.svg
            viewBox="0 0 24 24"
            className="w-4 h-4"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.3, delay: 0.1 }}
          >
            <motion.path
              d="M5 13l4 4L19 7"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </motion.svg>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ============================================================
// 5. プレスフィードバック（ボタン用ラッパー）
// ============================================================
export function PressScale({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      whileTap={{ scale: 0.97 }}
      whileHover={{ scale: 1.01 }}
      transition={{ type: "spring", stiffness: 400, damping: 20 }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ============================================================
// 6. スライドイン（トースト通知用）
// ============================================================
export function SlideInToast({
  show,
  message,
  type = "success",
  onClose,
}: {
  show: boolean;
  message: string;
  type?: "success" | "error" | "info";
  onClose?: () => void;
}) {
  useEffect(() => {
    if (show && onClose) {
      const t = setTimeout(onClose, 3000);
      return () => clearTimeout(t);
    }
  }, [show, onClose]);

  const colors = {
    success: "bg-green-600",
    error: "bg-red-600",
    info: "bg-blue-600",
  };

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 50, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.95 }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          className={`fixed bottom-6 right-6 z-50 ${colors[type]} text-white px-5 py-3 rounded-xl shadow-lg text-sm font-medium`}
          onClick={onClose}
        >
          {message}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ============================================================
// 7. 数値ハイライト（金額が変わった時にパルス）
// ============================================================
export function PulseOnChange({
  children,
  value,
  className = "",
}: {
  children: React.ReactNode;
  value: unknown;
  className?: string;
}) {
  const [pulse, setPulse] = useState(false);
  const prevRef = useRef(value);

  useEffect(() => {
    if (prevRef.current !== value) {
      setPulse(true);
      prevRef.current = value;
      const t = setTimeout(() => setPulse(false), 600);
      return () => clearTimeout(t);
    }
  }, [value]);

  return (
    <motion.span
      animate={
        pulse
          ? { scale: [1, 1.05, 1], color: ["inherit", "#3b82f6", "inherit"] }
          : {}
      }
      transition={{ duration: 0.5 }}
      className={className}
    >
      {children}
    </motion.span>
  );
}
