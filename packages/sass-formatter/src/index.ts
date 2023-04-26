import type { Service } from '@volar/language-service';
import { SassFormatter } from 'sass-formatter';

export default (configs: Parameters<typeof SassFormatter.Format>[1]): Service => (): ReturnType<Service> => ({

	provideDocumentFormattingEdits(document, range, options) {

		if (document.languageId !== 'sass')
			return;

		const _options: typeof configs = {
			...configs,
			insertSpaces: options.insertSpaces,
		};

		// don't set when options.insertSpaces is false to avoid sass-formatter internal judge bug
		if (options.insertSpaces)
			_options.tabSize = options.tabSize;

		return [{
			newText: SassFormatter.Format(document.getText(), _options),
			range: range,
		}];
	},
});
