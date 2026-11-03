// Browser-only test fixture. Not an entrypoint of the production build; no database access.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BookCard } from '../../src/ui/BookCard';
import { Button } from '../../src/ui/Button';
import { Dialog } from '../../src/ui/Dialog';
import { TextField } from '../../src/ui/TextField';
import '../../src/ui/styles.css';

export function ComponentFixture() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState(false);
  return (
    <main className="page">
      <h1>Тестовые компоненты</h1>
      <p>Только тестовые данные. Ничего не сохраняется.</p>
      <div className="settings-stack">
        <Button
          onClick={() => {
            setOpen(true);
          }}
        >
          Проверить поле
        </Button>
        <Button disabled>Недоступное действие</Button>
        <div style={{ width: 'min(100%, 10rem)' }}>
          <BookCard
            title="Тестовая книга с длинным названием"
            authors={['Тестовый автор']}
            coverUrl="data:image/png;base64,YQ=="
            onOpen={() => {
              setSelected(true);
            }}
          />
        </div>
        {selected && <p role="status">Выбрана тестовая карточка</p>}
      </div>
      <Dialog
        title="Тестовое поле"
        open={open}
        onClose={() => {
          setOpen(false);
        }}
      >
        <TextField
          label="Название"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
          hint="Введите не менее трёх символов"
          error={
            value.length > 0 && value.length < 3
              ? 'Слишком короткое название'
              : ''
          }
        />
        <Button
          onClick={() => {
            setOpen(false);
          }}
        >
          Готово
        </Button>
      </Dialog>
    </main>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing test root');
createRoot(root).render(<ComponentFixture />);
