// ============================================================================
// Modal.tsx - Accessible, animated modal dialog component
// ============================================================================
//
// Renders a portal-based modal dialog with backdrop overlay, focus trapping,
// body scroll locking, and enter/exit animations. Used for forms,
// confirmations, and content display throughout the trading terminal.
//
// Exports sub-components ModalHeader, ModalBody, and ModalFooter for
// structured content layout.
//
// Key props: isOpen, onClose, title, size ('sm'|'md'|'lg'|'xl'|'full'),
// showCloseButton, closeOnBackdropClick, closeOnEsc, initialFocusRef.
//
// ============================================================================

import React, { useEffect, useRef, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';

// Utility for cleaner class merging (reuse from project or inline)
function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

// Modal size configurations
const sizeClasses = {
  sm: 'max-w-md',      // 448px - Confirmations
  md: 'max-w-xl',      // 576px - Standard forms (default)
  lg: 'max-w-3xl',     // 768px - Complex forms
  xl: 'max-w-5xl',     // 1024px - Full layouts
  full: 'max-w-full max-h-full m-4' // Full screen with margin
};

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  size?: keyof typeof sizeClasses;
  showCloseButton?: boolean;
  closeOnBackdropClick?: boolean;
  closeOnEsc?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement>;
  className?: string;
  backdropClassName?: string;
}

export function Modal({
  isOpen,
  onClose,
  children,
  title,
  size = 'md',
  showCloseButton = true,
  closeOnBackdropClick = true,
  closeOnEsc = true,
  initialFocusRef,
  className,
  backdropClassName,
}: ModalProps) {
  // Refs for focus management
  const modalRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);
  const titleId = useRef(`modal-title-${Math.random().toString(36).substr(2, 9)}`).current;
  
  // Mount state for animation (delayed unmount for exit animation)
  const [isMounted, setIsMounted] = useState(isOpen);

  // Handle mount/unmount with animation timing
  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      // Store previously focused element to restore later
      previousActiveElement.current = document.activeElement as HTMLElement;
    } else {
      // Delay unmount to allow exit animation
      const timer = setTimeout(() => {
        setIsMounted(false);
      }, 200); // Match transition duration
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Body scroll lock
  useEffect(() => {
    if (isOpen) {
      // Calculate scrollbar width to prevent layout shift
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      
      document.body.style.overflow = 'hidden';
      document.body.style.paddingRight = `${scrollbarWidth}px`;
      
      return () => {
        document.body.style.overflow = '';
        document.body.style.paddingRight = '';
      };
    }
  }, [isOpen]);

  // Initial focus management
  useEffect(() => {
    if (isOpen && isMounted) {
      // Small delay to ensure DOM is ready
      const timer = setTimeout(() => {
        if (initialFocusRef?.current) {
          initialFocusRef.current.focus();
        } else if (modalRef.current) {
          // Find first focusable element
          const focusable = modalRef.current.querySelector<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          );
          focusable?.focus();
        }
      }, 50);
      
      return () => clearTimeout(timer);
    }
  }, [isOpen, isMounted, initialFocusRef]);

  // Return focus on close
  useEffect(() => {
    return () => {
      previousActiveElement.current?.focus();
    };
  }, []);

  // Focus trap implementation
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && closeOnEsc) {
      e.preventDefault();
      onClose();
      return;
    }

    if (e.key === 'Tab' && modalRef.current) {
      const focusableElements = Array.from(
        modalRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter(el => !el.hasAttribute('disabled'));

      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === firstElement || !modalRef.current.contains(document.activeElement)) {
          lastElement.focus();
          e.preventDefault();
        }
      } else {
        if (document.activeElement === lastElement) {
          firstElement.focus();
          e.preventDefault();
        }
      }
    }
  }, [closeOnEsc, onClose]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, handleKeyDown]);

  // Handle backdrop click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && closeOnBackdropClick) {
      onClose();
    }
  };

  // Don't render if not mounted (controls animation lifecycle)
  if (!isMounted) return null;

  const modalContent = (
    <div
      className={cn(
        'fixed inset-0 z-50 overflow-y-auto',
        isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
      )}
      aria-labelledby={title ? titleId : undefined}
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-200',
          isOpen ? 'opacity-100' : 'opacity-0',
          backdropClassName
        )}
        onClick={handleBackdropClick}
        aria-hidden="true"
      />

      {/* Modal Container */}
      <div className="flex min-h-full items-center justify-center p-4 text-center sm:p-0">
        <div
          ref={modalRef}
          className={cn(
            'relative transform overflow-hidden rounded-xl bg-gray-900 text-left align-middle shadow-2xl transition-all duration-200',
            'border border-gray-800',
            isOpen ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-4',
            sizeClasses[size],
            size === 'full' ? 'w-full h-full flex flex-col' : 'w-full',
            className
          )}
        >
          {/* Header */}
          {(title || showCloseButton) && (
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
              {title ? (
                <h3 
                  id={titleId}
                  className="text-lg font-semibold text-white"
                >
                  {title}
                </h3>
              ) : (
                <div />
              )}
              
              {showCloseButton && (
                <button
                  onClick={onClose}
                  className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
                  aria-label="Close dialog"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>
          )}

          {/* Content Body */}
          <div className={cn(
            "px-6 py-4",
            size !== 'full' && "max-h-[calc(100vh-200px)] overflow-y-auto"
          )}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );

  // Render via portal to avoid z-index issues
  return createPortal(modalContent, document.body);
}

// Sub-components for structured content (optional usage)

interface ModalHeaderProps {
  children: React.ReactNode;
  className?: string;
}

export function ModalHeader({ children, className }: ModalHeaderProps) {
  return (
    <div className={cn("px-6 py-4 border-b border-gray-800", className)}>
      {children}
    </div>
  );
}

interface ModalBodyProps {
  children: React.ReactNode;
  className?: string;
}

export function ModalBody({ children, className }: ModalBodyProps) {
  return (
    <div className={cn("px-6 py-4", className)}>
      {children}
    </div>
  );
}

interface ModalFooterProps {
  children: React.ReactNode;
  className?: string;
}

export function ModalFooter({ children, className }: ModalFooterProps) {
  return (
    <div className={cn("px-6 py-4 border-t border-gray-800 flex items-center justify-end gap-3", className)}>
      {children}
    </div>
  );
}

// Default export is main Modal component
export default Modal;