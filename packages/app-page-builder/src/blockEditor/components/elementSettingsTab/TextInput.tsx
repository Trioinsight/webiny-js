import React, { useEffect, useState } from "react";
import { Input } from "@webiny/ui/Input";

interface TextInputProps {
    label?: string;
    value: string;
    onChange: (value: string) => void;
    onBlur?: () => void;
}

const TextInput: React.FC<TextInputProps> = ({ label, value, onChange, onBlur }) => {
    const [localValue, setLocalValue] = useState(value);

    useEffect(() => {
        if (localValue !== value) {
            setLocalValue(value);
        }
    }, [value]);

    return (
        <Input
            label={label}
            value={localValue}
            onChange={value => {
                onChange(value);
                setLocalValue(value);
            }}
            onBlur={onBlur}
        />
    );
};

export default TextInput;
