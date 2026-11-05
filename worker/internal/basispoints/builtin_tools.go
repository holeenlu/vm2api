package basispoints

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// Built-in client tools (ported from james-6-23/codex2api proxy/basispoints/builtin_tools.go, MIT,
// commit a55e1ec4 "close Excel bridge gaps for images, tools and streams"): local_shell, shell and
// apply_patch are executed by the client; the model only generates the call. BPS has no such tools,
// so a declared built-in is offered to the model as an ordinary catalog function of the same name and
// relayed through run_officejs like any other function. The client receives its native call item
// (local_shell_call / shell_call / apply_patch_call); its history items and results are lowered back to
// function_call / function_call_output before translation, so replay and rebuild stay unchanged.
type builtinTool struct {
	callType    string
	idPrefix    string
	description string
	parameters  object
}

func stringArraySchema(description string) object {
	return object{"type": "array", "items": object{"type": "string"}, "minItems": 1, "description": description}
}

var builtinClientTools = map[string]builtinTool{
	"local_shell": {
		callType:    "local_shell_call",
		idPrefix:    "lsh_",
		description: "Run one program on the client machine (built-in local_shell tool).",
		parameters: object{
			"type": "object",
			"properties": object{
				"command":           stringArraySchema(`Program and arguments, for example ["bash","-lc","ls -la"].`),
				"working_directory": object{"type": "string"},
				"timeout_ms":        object{"type": "integer"},
				"env":               object{"type": "object", "additionalProperties": object{"type": "string"}},
			},
			"required":             []any{"command"},
			"additionalProperties": false,
		},
	},
	"shell": {
		callType:    "shell_call",
		idPrefix:    "sh_",
		description: "Run shell commands in order on the client machine (built-in shell tool).",
		parameters: object{
			"type": "object",
			"properties": object{
				"commands":          stringArraySchema("Shell command lines to run in order."),
				"timeout_ms":        object{"type": "integer"},
				"max_output_length": object{"type": "integer"},
			},
			"required":             []any{"commands"},
			"additionalProperties": false,
		},
	},
	"apply_patch": {
		callType:    "apply_patch_call",
		idPrefix:    "apc_",
		description: "Create, update or delete one file on the client machine (built-in apply_patch tool). Use a V4A diff for create_file and update_file.",
		parameters: object{
			"type": "object",
			"properties": object{
				"type": object{"type": "string", "enum": []any{"create_file", "update_file", "delete_file"}},
				"path": object{"type": "string"},
				"diff": object{"type": "string", "description": "V4A diff; omit for delete_file."},
			},
			"required":             []any{"type", "path"},
			"additionalProperties": false,
		},
	},
}

func isBuiltinToolKind(kind string) bool {
	_, ok := builtinClientTools[kind]
	return ok
}

// builtinKindForCall maps a call or call-output item type to its tool kind.
func builtinKindForCall(itemType string) (string, bool) {
	itemType = strings.TrimSuffix(itemType, "_output")
	for kind, spec := range builtinClientTools {
		if spec.callType == itemType {
			return kind, true
		}
	}
	return "", false
}

func isBuiltinCall(item object) bool {
	_, ok := builtinKindForCall(text(item["type"]))
	return ok && !strings.HasSuffix(text(item["type"]), "_output")
}

// declareBuiltin records a declared built-in client tool; registerBuiltins adds it to the catalog.
func (b *Bridge) declareBuiltin(kind string) {
	for _, existing := range b.builtins {
		if existing == kind {
			return
		}
	}
	b.builtins = append(b.builtins, kind)
}

// registerBuiltins offers each declared built-in as a root catalog function of the same name.
// A client tool already declared under that name keeps it.
func (b *Bridge) registerBuiltins(catalog []any) ([]any, error) {
	for _, kind := range b.builtins {
		if _, taken := b.tools[kind]; taken {
			continue
		}
		spec := builtinClientTools[kind]
		entries, err := b.collectTools([]any{object{"type": "function", "name": kind, "description": spec.description, "parameters": spec.parameters}}, "", "tools."+kind, true)
		if err != nil {
			return nil, err
		}
		if b.builtinTools == nil {
			b.builtinTools = make(map[string]bool)
		}
		b.builtinTools[kind] = true
		catalog = append(catalog, entries...)
	}
	return catalog, nil
}

// clientBuiltin turns a relayed call of a registered built-in into the client's native call item.
// Replay keeps the function form, which is what history lowering produces on the next turn.
func (b *Bridge) clientBuiltin(result object) (object, error) {
	kind := text(result["name"])
	if !b.builtinTools[kind] || text(result["type"]) != "function_call" || result["namespace"] != nil {
		return result, nil
	}
	var args object
	if err := decode([]byte(text(result["arguments"])), &args); err != nil || args == nil {
		return nil, fmt.Errorf("basispoints built-in %s arguments are invalid", kind)
	}
	return builtinCallItem(kind, text(result["call_id"]), args)
}

// lowerBuiltinHistory rewrites built-in call items and their results into function_call /
// function_call_output items addressed to the same-named catalog function. The slice and its
// items are copied, never modified.
func lowerBuiltinHistory(input any) (any, bool) {
	items, ok := input.([]any)
	if !ok {
		return input, false
	}
	var lowered []any
	for index, raw := range items {
		item, _ := raw.(object)
		kind, builtin := builtinKindForCall(text(item["type"]))
		if !builtin {
			if lowered != nil {
				lowered = append(lowered, raw)
			}
			continue
		}
		if lowered == nil {
			lowered = append(make([]any, 0, len(items)), items[:index]...)
		}
		if strings.HasSuffix(text(item["type"]), "_output") {
			lowered = append(lowered, object{"type": "function_call_output", "call_id": item["call_id"], "output": builtinOutputText(item)})
			continue
		}
		args, err := builtinArguments(item)
		if err != nil {
			// Leave a malformed item for the translator to reject with its own message.
			lowered = append(lowered, raw)
			continue
		}
		encoded, _ := json.Marshal(args)
		lowered = append(lowered, object{"type": "function_call", "call_id": item["call_id"], "name": kind, "arguments": string(encoded), "status": "completed"})
	}
	if lowered == nil {
		return input, false
	}
	return lowered, true
}

func stringList(value any, field string) ([]any, error) {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return nil, fmt.Errorf("basispoints %s must be a nonempty string array", field)
	}
	for _, item := range items {
		if s, ok := item.(string); !ok || strings.TrimSpace(s) == "" {
			return nil, fmt.Errorf("basispoints %s must contain only nonempty strings", field)
		}
	}
	return items, nil
}

func copyOptional(target, source object, fields ...string) {
	for _, field := range fields {
		if value, ok := source[field]; ok && value != nil {
			target[field] = value
		}
	}
}

// optionalInteger keeps a non-negative integer field. A quoted number is accepted and anything else
// is dropped: a wrongly typed optional field would make strictly typed clients reject the call item.
func optionalInteger(target, source object, field string) {
	var number json.Number
	switch value := source[field].(type) {
	case json.Number:
		number = value
	case string:
		number = json.Number(strings.TrimSpace(value))
	default:
		return
	}
	if parsed, err := number.Int64(); err == nil && parsed >= 0 {
		target[field] = json.Number(strconv.FormatInt(parsed, 10))
	}
}

func optionalString(target, source object, field string) {
	if value, ok := source[field].(string); ok && strings.TrimSpace(value) != "" {
		target[field] = value
	}
}

// stringMap keeps scalar entries as strings, the only env value type the client accepts.
func stringMap(value any) object {
	env := object{}
	source, _ := value.(object)
	for key, raw := range source {
		switch v := raw.(type) {
		case string:
			env[key] = v
		case json.Number, bool:
			env[key] = fmt.Sprint(v)
		}
	}
	return env
}

// builtinCallItem builds the client's native call item from decoded envelope arguments.
func builtinCallItem(kind, callID string, args object) (object, error) {
	spec := builtinClientTools[kind]
	result := object{"type": spec.callType, "id": spec.idPrefix + fingerprint(callID), "call_id": callID, "status": "completed"}
	switch kind {
	case "local_shell":
		command, err := stringList(args["command"], "local_shell command")
		if err != nil {
			return nil, err
		}
		action := object{"type": "exec", "command": command, "env": stringMap(args["env"])}
		optionalString(action, args, "working_directory")
		optionalInteger(action, args, "timeout_ms")
		result["action"] = action
	case "shell":
		commands, err := stringList(args["commands"], "shell commands")
		if err != nil {
			return nil, err
		}
		action := object{"commands": commands}
		optionalInteger(action, args, "timeout_ms")
		optionalInteger(action, args, "max_output_length")
		result["action"] = action
	case "apply_patch":
		operation := object{"type": text(args["type"]), "path": text(args["path"])}
		switch operation["type"] {
		case "create_file", "update_file":
			diff, ok := args["diff"].(string)
			// An empty create_file diff makes an empty file; an empty update changes nothing.
			if !ok || operation["type"] == "update_file" && strings.TrimSpace(diff) == "" {
				return nil, fmt.Errorf("basispoints apply_patch %s requires a diff", operation["type"])
			}
			operation["diff"] = diff
		case "delete_file":
		default:
			return nil, fmt.Errorf("basispoints apply_patch type must be create_file, update_file or delete_file")
		}
		if strings.TrimSpace(text(operation["path"])) == "" {
			return nil, fmt.Errorf("basispoints apply_patch requires a path")
		}
		result["operation"] = operation
	default:
		return nil, fmt.Errorf("basispoints built-in tool %q is not relayable", kind)
	}
	return result, nil
}

// builtinArguments reverses builtinCallItem for history: the arguments the model sent.
func builtinArguments(item object) (object, error) {
	kind, _ := builtinKindForCall(text(item["type"]))
	args := object{}
	switch kind {
	case "local_shell", "shell":
		action, ok := item["action"].(object)
		if !ok {
			return nil, fmt.Errorf("basispoints history %s call requires an action", kind)
		}
		if kind == "local_shell" {
			copyOptional(args, action, "command", "working_directory", "timeout_ms", "env")
		} else {
			copyOptional(args, action, "commands", "timeout_ms", "max_output_length")
		}
	case "apply_patch":
		operation, ok := item["operation"].(object)
		if !ok {
			return nil, fmt.Errorf("basispoints history apply_patch call requires an operation")
		}
		copyOptional(args, operation, "type", "path", "diff")
	default:
		return nil, fmt.Errorf("basispoints history item is not a built-in tool call")
	}
	return args, nil
}

// builtinOutputText renders a built-in tool result as the text BPS receives in a function_call_output.
func builtinOutputText(item object) any {
	switch text(item["type"]) {
	case "shell_call_output":
		chunks, ok := item["output"].([]any)
		if !ok {
			return item["output"]
		}
		var out strings.Builder
		for i, raw := range chunks {
			chunk, _ := raw.(object)
			if i > 0 {
				out.WriteString("\n\n")
			}
			fmt.Fprintf(&out, "Command %d", i+1)
			if outcome, ok := chunk["outcome"].(object); ok {
				switch text(outcome["type"]) {
				case "exit":
					if code, ok := outcome["exit_code"].(json.Number); ok {
						fmt.Fprintf(&out, " exited with code %s", code)
					} else {
						out.WriteString(" exited without an exit code")
					}
				case "timeout":
					out.WriteString(" timed out")
				}
			}
			if stdout := text(chunk["stdout"]); stdout != "" {
				out.WriteString("\nstdout:\n" + stdout)
			}
			if stderr := text(chunk["stderr"]); stderr != "" {
				out.WriteString("\nstderr:\n" + stderr)
			}
		}
		return out.String()
	case "apply_patch_call_output":
		status, body := text(item["status"]), text(item["output"])
		switch {
		case status == "":
			return body
		case body == "":
			return "Patch " + status
		default:
			return "Patch " + status + ":\n" + body
		}
	case "local_shell_call_output":
		if status := text(item["status"]); status != "" && status != "completed" {
			return "(command " + status + ")\n" + text(item["output"])
		}
		return item["output"]
	default:
		return item["output"]
	}
}
