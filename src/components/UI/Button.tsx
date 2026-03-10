// ============================================================================
// Button.tsx - Reusable, polymorphic button component
// ============================================================================
//
// Renders a styled button with support for multiple visual variants
// (primary, secondary, danger, ghost, link), three sizes (sm, md, lg),
// optional left/right icons, and a loading spinner state.
//
// Polymorphic via the "as" prop (renders as <button>, <a>, or custom component).
// Uses forwardRef for ref forwarding.
//
// Key props: variant, size, isLoading, isDisabled, fullWidth, leftIcon,
// rightIcon, as, className. Spreads remaining native button attributes.
//
// ============================================================================

import React, { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';

// Utility for cleaner class merging
function cn(...inputs: (string | boolean | undefined | null)[]) {
  return inputs.filter(Boolean).join(' ');
}

// Button variant and size types
type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'link';
type ButtonSize = 'sm' | 'md' | 'lg';

// Props interface
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  isDisabled?: boolean;
  fullWidth?: boolean;
  leftIcon?: React.ElementType;
  rightIcon?: React.ElementType;
  as?: React.ElementType | 'button' | 'a';
  href?: string;
}

// Map variants to Tailwind classes
const variantStyles: Record<ButtonVariant, string> = {
  primary: 
    'bg-emerald-600 text-white hover:bg-emerald-500 active:bg-emerald-700 ' +
    'focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-gray-900 ' +
    'shadow-lg shadow-emerald-900/20',
  
  secondary: 
    'bg-gray-800 text-gray-200 hover:bg-gray-700 active:bg-gray-900 ' +
    'border border-gray-700 hover:border-gray-600 ' +
    'focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 focus:ring-offset-gray-900',
  
  danger: 
    'bg-rose-600 text-white hover:bg-rose-500 active:bg-rose-700 ' +
    'focus:ring-2 focus:ring-rose-500 focus:ring-offset-2 focus:ring-offset-gray-900 ' +
    'shadow-lg shadow-rose-900/20',
  
  ghost: 
    'bg-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800 ' +
    'active:bg-gray-900 ' +
    'focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 focus:ring-offset-gray-900',
  
  link: 
    'bg-transparent text-blue-400 hover:text-blue-300 hover:underline ' +
    'active:text-blue-500 p-0 h-auto ' +
    'focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-900'
};

// Map sizes to Tailwind classes
const sizeStyles: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs gap-1.5',
  md: 'px-4 py-2 text-sm gap-2',
  lg: 'px-6 py-3 text-base gap-2.5'
};

// Icon sizes based on button size
const iconSizes: Record<ButtonSize, number> = {
  sm: 14,
  md: 16,
  lg: 20
};

// Loading spinner sizes
const spinnerSizes: Record<ButtonSize, number> = {
  sm: 12,
  md: 14,
  lg: 18
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({
  children,
  variant = 'primary',
  size = 'md',
  isLoading = false,
  isDisabled = false,
  fullWidth = false,
  leftIcon: LeftIcon,
  rightIcon: RightIcon,
  className,
  as: Component = 'button',
  type = 'button',
  ...props
}, ref) => {
  
  // Determine if component is an anchor tag
  const isAnchor = Component === 'a';
  
  // Combine disabled states
  const disabled = isDisabled || isLoading;
  
  // Base classes always applied
  const baseClasses = 
    'inline-flex items-center justify-center rounded-lg font-medium ' +
    'transition-all duration-150 ease-in-out ' +
    'outline-none select-none whitespace-nowrap ' +
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none ' +
    'active:scale-[0.98]';
  
  // Merge all classes
  const classes = cn(
    baseClasses,
    variantStyles[variant],
    sizeStyles[size],
    fullWidth && 'w-full',
    className
  );

  // Icon size for this button size
  const iconSize = iconSizes[size];
  const spinnerSize = spinnerSizes[size];

  // Content rendering
  const content = (
    <>
      {/* Left icon or loading spinner */}
      {(LeftIcon || isLoading) && (
        <span className="inline-flex items-center">
          {isLoading ? (
            <Loader2 
              size={spinnerSize} 
              className="animate-spin" 
              aria-hidden="true"
            />
          ) : (
            LeftIcon && <LeftIcon size={iconSize} aria-hidden="true" />
          )}
        </span>
      )}
      
      {/* Button text/children */}
      {children && (
        <span className={isLoading ? 'opacity-90' : ''}>
          {children}
        </span>
      )}
      
      {/* Right icon */}
      {RightIcon && !isLoading && (
        <span className="inline-flex items-center">
          <RightIcon size={iconSize} aria-hidden="true" />
        </span>
      )}
    </>
  );

  // Render as anchor or button
  if (isAnchor) {
    return (
      <a
        ref={ref as React.Ref<HTMLAnchorElement>}
        className={classes}
        aria-busy={isLoading}
        aria-disabled={disabled}
        {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled}
      aria-busy={isLoading}
      aria-disabled={disabled}
      {...props}
    >
      {content}
    </button>
  );
});

Button.displayName = 'Button';

export default Button;