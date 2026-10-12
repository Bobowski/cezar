import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { useLayoutEffect, useRef } from 'react'

import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@/components/ui/input-otp'

/**
 * The six-digit authenticator code. `one-time-code` lets a phone offer the code from its
 * authenticator, and `onComplete` submits on the sixth digit — nobody presses Enter on these.
 */
export function CodeField({
  id,
  value,
  onChange,
  onComplete,
  disabled,
  invalid,
  autoFocus = true,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  onComplete?: (value: string) => void
  disabled?: boolean
  invalid?: boolean
  autoFocus?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const hadFocus = useRef(false)
  // A browser takes focus off a control that gets disabled and never hands it back, so after a
  // rejected code the next digits went nowhere. Whoever was typing here is typing here again.
  useLayoutEffect(() => {
    if (disabled) hadFocus.current = document.activeElement === input.current
    else if (hadFocus.current) {
      hadFocus.current = false
      input.current?.focus()
    }
  }, [disabled])

  return (
    <InputOTP
      ref={input}
      id={id}
      maxLength={6}
      pattern={REGEXP_ONLY_DIGITS}
      inputMode="numeric"
      autoComplete="one-time-code"
      autoFocus={autoFocus}
      value={value}
      onChange={onChange}
      onComplete={onComplete}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      containerClassName="justify-center"
    >
      <InputOTPGroup>
        {[0, 1, 2].map((index) => (
          <InputOTPSlot key={index} index={index} aria-invalid={invalid || undefined} />
        ))}
      </InputOTPGroup>
      <InputOTPSeparator />
      <InputOTPGroup>
        {[3, 4, 5].map((index) => (
          <InputOTPSlot key={index} index={index} aria-invalid={invalid || undefined} />
        ))}
      </InputOTPGroup>
    </InputOTP>
  )
}
