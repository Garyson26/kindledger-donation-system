import React from 'react';

const Button = ({
  children,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  fullWidth = false,
  onClick,
  type = 'button',
  className = '',
  ...props
}) => {
  // Base button classes
  const baseClasses = 'inline-flex items-center justify-center gap-2 font-medium border-none rounded-lg cursor-pointer transition-all duration-200 relative overflow-hidden select-none whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-offset-2';

  // Variant classes
  const variantClasses = {
    primary: 'bg-gradient-to-br from-[var(--kl-primary)] to-[var(--kl-primary-dark)] text-white shadow-md hover:from-[var(--kl-primary-dark)] hover:to-[var(--kl-primary-darkest)] hover:-translate-y-0.5 hover:shadow-lg active:translate-y-0 active:shadow-md focus:ring-[var(--kl-primary)]',
    secondary: 'bg-gradient-to-br from-green-600 to-green-700 text-white shadow-md hover:from-green-700 hover:to-green-800 hover:-translate-y-0.5 hover:shadow-lg active:translate-y-0 active:shadow-md focus:ring-green-600',
    outline: 'bg-transparent text-[var(--kl-primary)] border-2 border-[var(--kl-primary)] hover:bg-[var(--kl-primary)] hover:text-white hover:-translate-y-0.5 hover:shadow-md focus:ring-[var(--kl-primary)]',
    success: 'bg-gradient-to-br from-green-500 to-green-700 text-white shadow-md hover:from-green-700 hover:to-green-800 hover:-translate-y-0.5 hover:shadow-lg active:translate-y-0 active:shadow-md focus:ring-green-600',
    error: 'bg-gradient-to-br from-red-600 to-red-700 text-white shadow-md hover:from-red-700 hover:to-red-800 hover:-translate-y-0.5 hover:shadow-lg active:translate-y-0 active:shadow-md focus:ring-red-600',
    warning: 'bg-gradient-to-br from-yellow-500 to-yellow-600 text-white shadow-md hover:from-yellow-600 hover:to-yellow-700 hover:-translate-y-0.5 hover:shadow-lg active:translate-y-0 active:shadow-md focus:ring-yellow-600',
  };

  // Size classes
  const sizeClasses = {
    sm: 'px-3 py-2 text-sm min-h-[36px]',
    md: 'px-4 py-3 text-base min-h-[44px]',
    lg: 'px-6 py-4 text-lg min-h-[52px]',
    xl: 'px-8 py-5 text-xl min-h-[60px]',
  };

  // Disabled/Loading classes
  const stateClasses = (disabled || loading)
    ? 'opacity-60 cursor-not-allowed transform-none shadow-none hover:transform-none hover:shadow-none'
    : '';

  // Full width class
  const widthClass = fullWidth ? 'w-full' : '';

  // Combine all classes
  const buttonClasses = [
    baseClasses,
    variantClasses[variant] || variantClasses.primary,
    sizeClasses[size] || sizeClasses.md,
    stateClasses,
    widthClass,
    className
  ].filter(Boolean).join(' ');

  return (
    <button
      type={type}
      className={buttonClasses}
      disabled={disabled || loading}
      onClick={onClick}
      {...props}
    >
      {loading && (
        <svg
          className="animate-spin h-4 w-4 border-2 border-transparent border-t-current rounded-full"
          viewBox="0 0 24 24"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle>
        </svg>
      )}
      <span className={loading ? 'opacity-80' : ''}>{children}</span>
    </button>
  );
};

export default Button;