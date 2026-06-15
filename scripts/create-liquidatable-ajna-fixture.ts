import {
  handleMainError,
  main,
} from './create-liquidatable-ajna-fixture-cli';

if (require.main === module) {
  main().catch(handleMainError);
}
