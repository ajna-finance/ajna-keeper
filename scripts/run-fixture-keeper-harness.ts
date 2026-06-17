import {
  handleMainError,
  main,
} from './fixture-keeper-harness-cli';

if (require.main === module) {
  main().catch(handleMainError);
}
