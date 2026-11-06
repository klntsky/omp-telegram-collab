export const FORBIDDEN_ARGS: Record<string, true> = {
  '--session': true, '-s': true, '--session-dir': true, '--resume': true, '-r': true,
  '--continue': true, '-c': true, '--no-session': true, '--restore': true, '--fork': true,
  '--mode': true, '--print': true, '-p': true, '--goal': true, '--cwd': true,
  '--help': true, '-h': true, '--version': true,
};

export const OMP_STRING_ARGS: Record<string, true> = {
  '--cwd': true, '--config': true, '--add-dir': true, '--mode': true, '--fork': true,
  '--provider': true, '--model': true, '--smol': true, '--slow': true, '--goal': true,
  '--prewalk-into': true, '--plan-yolo-into': true, '--max-time': true, '--warn-cost': true,
  '--max-cost': true, '--service-tier': true, '--api-key': true, '--system-prompt': true,
  '--system-prompt-template': true, '--append-system-prompt': true, '--provider-session-id': true,
  '--prompt-cache-key': true, '--session-dir': true, '--models': true, '--tools': true,
  '--thinking': true, '--export': true, '--hook': true, '--extension': true, '-e': true,
  '--trusted-extension': true, '--plugin-dir': true, '--skills': true, '--approval-mode': true,
  '--profile': true, '--alias': true,
};

export const PRESET_MODEL_ARGS: Record<string, true> = {
  '--provider': true, '--model': true, '--smol': true, '--slow': true, '--models': true, '--thinking': true,
};

export function ompArguments(args: string[]): { flag: string; value?: string; args: string[] }[] {
  const result: { flag: string; value?: string; args: string[] }[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') {
      result.push({ flag: arg, args: args.slice(index) });
      break;
    }
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (equals >= 0) {
      result.push({ flag, value: arg.slice(equals + 1), args: [arg] });
    } else if (Object.hasOwn(OMP_STRING_ARGS, flag) && index + 1 < args.length) {
      const value = args[++index]!;
      result.push({ flag, value, args: [arg, value] });
    } else {
      result.push({ flag, args: [arg] });
    }
  }
  return result;
}
