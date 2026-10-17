'use client';
import {
    Button,
    Card,
    Checkbox,
    Chip,
    Dropdown,
    Input,
    Label,
    ListBox,
    Select,
    Switch,
    TextArea,
    TextField,
} from '@heroui/react';
// Thin wrappers over HeroUI v3's compound components, so pages stay short and
// every checkbox, switch, select, field and menu looks and behaves the same.
import type { Key, ReactNode } from 'react';

/** A HeroUI Card with an optional header row (icon, title, actions) and a padded body. */
export function Panel({
    title,
    icon,
    actions,
    children,
    className,
    padded = true,
}: {
    title?: ReactNode;
    icon?: ReactNode;
    actions?: ReactNode;
    children?: ReactNode;
    className?: string;
    padded?: boolean;
}) {
    return (
        <Card className={`panel ${className ?? ''}`}>
            {(title || actions) && (
                <div className="panel-head">
                    {icon}
                    {title && <h3 className="grow">{title}</h3>}
                    {!title && <span className="grow" />}
                    {actions}
                </div>
            )}
            {padded ? <div className="panel-body">{children}</div> : children}
        </Card>
    );
}

export function Check({
    isSelected,
    onChange,
    isDisabled,
    children,
    size,
}: {
    isSelected: boolean;
    onChange: (v: boolean) => void;
    isDisabled?: boolean;
    children?: ReactNode;
    size?: 'sm';
}) {
    // Checkbox.Content is the clickable part; it wraps the box and the label side by side.
    return (
        <Checkbox
            isSelected={isSelected}
            onChange={onChange}
            isDisabled={isDisabled}
            aria-label={typeof children === 'string' ? children : 'Select'}
        >
            <Checkbox.Content>
                <Checkbox.Control>
                    <Checkbox.Indicator />
                </Checkbox.Control>
                {children && <Label className={size === 'sm' ? 'text-xs' : 'text-sm'}>{children}</Label>}
            </Checkbox.Content>
        </Checkbox>
    );
}

export function Toggle({
    isSelected,
    onChange,
    isDisabled,
    children,
    label,
}: {
    isSelected: boolean;
    onChange: (v: boolean) => void;
    isDisabled?: boolean;
    children?: ReactNode;
    label?: string;
}) {
    return (
        <Switch isSelected={isSelected} onChange={onChange} isDisabled={isDisabled} size="sm" aria-label={label}>
            <Switch.Content>
                <Switch.Control>
                    <Switch.Thumb />
                </Switch.Control>
                {children && <Label>{children}</Label>}
            </Switch.Content>
        </Switch>
    );
}

export interface Option {
    key: string;
    label: string;
}

export function SelectField({
    label,
    value,
    onChange,
    options,
    placeholder,
    isDisabled,
    className,
}: {
    label?: string;
    value: string | null;
    onChange: (key: string) => void;
    options: Option[];
    placeholder?: string;
    isDisabled?: boolean;
    className?: string;
}) {
    return (
        <Select
            className={className ?? 'w-full'}
            placeholder={placeholder}
            selectedKey={value}
            onSelectionChange={(k: Key | null) => {
                if (k !== null) onChange(String(k));
            }}
            isDisabled={isDisabled}
            aria-label={label || placeholder}
        >
            {label && <Label>{label}</Label>}
            <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
                <ListBox>
                    {options.map((o) => (
                        <ListBox.Item key={o.key} id={o.key} textValue={o.label}>
                            {o.label}
                            <ListBox.ItemIndicator />
                        </ListBox.Item>
                    ))}
                </ListBox>
            </Select.Popover>
        </Select>
    );
}

export function TextInput({
    label,
    value,
    onChange,
    placeholder,
    type = 'text',
    isDisabled,
    mono,
    onEnter,
    onEscape,
    autoFocus,
    className,
}: {
    label?: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    type?: 'text' | 'number' | 'email' | 'password';
    isDisabled?: boolean;
    mono?: boolean;
    onEnter?: () => void;
    onEscape?: () => void;
    autoFocus?: boolean;
    className?: string;
}) {
    return (
        <TextField
            className={className ?? 'w-full'}
            value={value}
            onChange={onChange}
            type={type}
            isDisabled={isDisabled}
            aria-label={label || placeholder || 'Text'}
            autoFocus={autoFocus}
        >
            {label && <Label>{label}</Label>}
            <Input
                placeholder={placeholder}
                className={mono ? 'font-mono text-xs' : undefined}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && onEnter) onEnter();
                    if (e.key === 'Escape' && onEscape) {
                        e.stopPropagation();
                        onEscape();
                    }
                }}
            />
        </TextField>
    );
}

export function TextBox({
    value,
    onChange,
    rows = 16,
    label,
}: {
    value: string;
    onChange: (v: string) => void;
    rows?: number;
    label?: string;
}) {
    return (
        <TextField className="w-full" value={value} onChange={onChange} aria-label={label || 'Text'}>
            {label && <Label>{label}</Label>}
            <TextArea rows={rows} spellCheck={false} className="font-mono text-xs leading-relaxed" />
        </TextField>
    );
}

/** A button that opens a menu of actions (e.g. "Open app…"). */
export function ActionMenu({
    label,
    icon,
    items,
    onAction,
    isDisabled,
    size = 'sm',
}: {
    label: string;
    icon?: ReactNode;
    items: Option[];
    onAction: (key: string) => void;
    isDisabled?: boolean;
    size?: 'sm' | 'md';
}) {
    return (
        <Dropdown>
            <Button variant="secondary" size={size} isDisabled={isDisabled || !items.length}>
                {icon}
                {label}
            </Button>
            <Dropdown.Popover className="max-h-80 min-w-56">
                <Dropdown.Menu onAction={(k: Key) => onAction(String(k))}>
                    {items.map((o) => (
                        <Dropdown.Item key={o.key} id={o.key} textValue={o.label}>
                            <Label>{o.label}</Label>
                        </Dropdown.Item>
                    ))}
                </Dropdown.Menu>
            </Dropdown.Popover>
        </Dropdown>
    );
}

const chipColor = {
    ready: 'success',
    done: 'success',
    starting: 'warning',
    running: 'warning',
    action: 'warning',
    error: 'danger',
    failed: 'danger',
} as const;

/** Small status chip: colour comes from the status, text from `children`. */
export function StatusChip({ status, children, pulse }: { status: string; children: ReactNode; pulse?: boolean }) {
    const color = (chipColor as Record<string, 'success' | 'warning' | 'danger'>)[status] ?? 'default';
    return (
        <Chip size="sm" variant="soft" color={color}>
            <span className={`dot ${status} ${pulse ? 'pulse' : ''}`} />
            <Chip.Label>{children}</Chip.Label>
        </Chip>
    );
}
