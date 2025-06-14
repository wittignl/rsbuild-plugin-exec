# RSBuild Plugin Exec

A plugin for RSBuild that executes commands after successful compilation. Particularly useful for automatically restarting your scripts when developing for node and files change.

## Features

- Execute commands after successful compilation
- Environment-specific command configuration
- Graceful process management with proper cleanup
- Automatic process restart on recompilation
- Configurable start and restart delays
- Set when to execute, for example: `onlyOnWatch`

## Installation

```bash
npm install -D @wittignl/rsbuild-plugin-exec
# or
yarn add -D @wittignl/rsbuild-plugin-exec
# or
pnpm add -D @wittignl/rsbuild-plugin-exec
```

## Usage

Add the plugin to your RSBuild configuration:

```typescript
import { pluginExec } from '@wittignl/rsbuild-plugin-exec';

export default {
  // ...
  plugins: [
    pluginExec({
      default: () => ({
        command: 'node',
        args: ['./dist/server.js']
      })
    })
  ]
};
```

## Configuration

### Plugin Options

| Option | Type | Description |
|--------|------|-------------|
| `startDelay` | `number` | Milliseconds to wait after compilation before starting subprocesses |
| `default` | `Function` | Default command options to use if environment-specific options aren't provided |
| `environments` | `Record<string, Function>` | Environment-specific command options |

### Command Options

Each command configuration function returns an object with the following options:

| Option | Type | Description |
|--------|------|-------------|
| `command` | `string` | The command to execute |
| `args` | `string[]` | Arguments to pass to the command |
| `name` | `string` | Custom name for the process (defaults to command) |
| `env` | `Record<string, string>` | Additional environment variables |
| `restartDelay` | `number` | Delay before restarting the subprocess |
| `onlyOnFirstCompile` | `boolean` | Only execute the command on first compile |
| `onlyOnWatch` | `boolean` | Only execute the command when compiling in watch mode |

## Examples

### Basic Usage

```typescript
pluginExec({
  default: () => ({
    command: 'node',
    args: ['./dist/server.js'],
    onlyOnWatch: true
  })
})
```

```typescript
pluginExec({
    environments: {
        production: () => ({
            command: 'vercel',
            args: ['deploy']
        })
    }
})
```

### Environment-Specific Configuration

```typescript
{
    //...
    environments: {
        // ...
        backend: { // <-- Ensure identical environment keys
            //...
            output: {
                //...
                target: 'node'
            }
        }
    },
    plugins: [
        pluginExec({
            environments: {
                backend: () => ({ // <-- Ensure identical environment keys
                    // ...
                }),
                // ...
            }
        })
    ]
}
```

## Environment Variables

The following environment variables are automatically set for each subprocess:

- `NODE_ENV`: Set to the same value RSBuild is using
- `RSBUILD_ENV`: Set to the current environment name (RSBuild config)

## License

&copy; 2025 Wittig B.V.

Published under the [Mozilla Public License
Version 2.0](https://www.mozilla.org/en-US/MPL/2.0/)
