import { ReactNode } from 'react'

interface IconButtonProps {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'danger' | 'neutral'
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
  className?: string
  title?: string
}

export function IconButton({
  children,
  onClick,
  variant = 'neutral',
  size = 'md',
  disabled = false,
  className = '',
  title
}: IconButtonProps) {
  const sizeClasses = {
    sm: 'w-6 h-6',
    md: 'w-7 h-7',
    lg: 'w-8 h-8'
  }

  const variantClasses = {
    primary: `
      bg-gradient-to-tr from-glass-accent-blue to-glass-accent-blue
      hover:from-blue-600 hover:to-blue-500
      shadow-lg shadow-blue-500/30
      hover:shadow-blue-500/50
      ring-2 ring-white/20 hover:ring-white/30
    `,
    danger: `
      bg-glass-accent-red
      shadow-lg shadow-red-500/40
      ring-2 ring-white/20
      hover:scale-110 transition-transform
    `,
    neutral: `
      bg-white/20 hover:bg-white/30
      ring-1 ring-white/20 hover:ring-white/30
      hover:scale-110 transform
    `
  }

  const disabledClasses = disabled
    ? 'opacity-50 cursor-not-allowed pointer-events-none'
    : 'cursor-pointer'

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`
        interactive
        ${sizeClasses[size]}
        ${variantClasses[variant]}
        rounded-full
        transition-all duration-200 ease-apple
        flex items-center justify-center
        ${disabledClasses}
        ${className}
      `}
    >
      {children}
    </button>
  )
}

