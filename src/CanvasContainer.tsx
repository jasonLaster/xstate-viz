import React, { CSSProperties, useEffect, useRef } from 'react';
import { canvasModel, ZoomFactor } from './canvasMachine';
import { useCanvas } from './CanvasContext';
import { useMachine } from '@xstate/react';
import { createModel } from 'xstate/lib/model';
import { Point } from './pathUtils';
import { AnyState, EmbedContext } from './types';
import { useEmbed } from './embedContext';
import { isWithPlatformMetaKey, isTextInputLikeElement } from './utils';

const dragModel = createModel(
  {
    startPoint: { x: 0, y: 0 },
    dragPoint: { x: 0, y: 0 },
    dx: 0,
    dy: 0,
    embed: undefined as EmbedContext | undefined,
  },
  {
    events: {
      LOCK: () => ({}),
      RELEASE: () => ({}),
      GRAB: (point: Point) => ({ point }),
      DRAG: (point: Point) => ({ point }),
      UNGRAB: () => ({}),
    },
  },
);

const dragMachine = dragModel.createMachine({
  initial: 'checking_embedded_mode',
  states: {
    checking_embedded_mode: {
      always: [
        {
          target: 'in_embedded_mode',
          cond: (ctx) => !!ctx.embed?.isEmbedded && !ctx.embed.pan,
        },
        'released',
      ],
    },
    in_embedded_mode: {},
    released: {
      meta: {
        cursor: 'default',
      },
      invoke: {
        src: 'invokeDetectLock',
      },
      on: {
        LOCK: 'locked',
      },
    },
    locked: {
      initial: 'idle',
      entry: ['disableTextSelection'],
      exit: ['enableTextSelection'],
      on: { RELEASE: 'released' },
      invoke: {
        src: 'invokeDetectRelease',
      },
      states: {
        idle: {
          meta: {
            cursor: 'grab',
          },
          on: {
            GRAB: {
              target: 'grabbed',
              actions: dragModel.assign({
                startPoint: (_, e) => e.point,
                dragPoint: (_, e) => e.point,
              }),
            },
          },
        },
        grabbed: {
          meta: {
            cursor: 'grabbing',
          },
          on: {
            DRAG: 'dragging',
            UNGRAB: 'idle',
          },
        },
        dragging: {
          tags: ['dragging'],
          meta: {
            cursor: 'grabbing',
          },
          entry: [
            dragModel.assign({
              dragPoint: (_, e: ReturnType<typeof dragModel.events.DRAG>) =>
                e.point,
              dx: (ctx, e) => ctx.dragPoint.x - e.point.x,
              dy: (ctx, e) => ctx.dragPoint.y - e.point.y,
            }) as any,
          ],
          on: {
            DRAG: { target: 'dragging', internal: false },
            UNGRAB: 'idle',
          },
        },
      },
    },
  },
});

const getCursorByState = (state: AnyState) =>
  (Object.values(state.meta)[0] as { cursor?: CSSProperties['cursor'] })
    ?.cursor;

export const CanvasContainer: React.FC = ({ children }) => {
  const canvasService = useCanvas();
  const embed = useEmbed();
  const canvasRef = useRef<HTMLDivElement>(null!);
  const [state, send] = useMachine(
    dragMachine.withContext({ ...dragModel.initialContext, embed }).withConfig({
      actions: {
        disableTextSelection: () => {
          canvasRef.current.style.userSelect = 'none';
        },
        enableTextSelection: () => {
          canvasRef.current.style.userSelect = 'unset';
        },
      },
      services: {
        invokeDetectLock: () => (sendBack) => {
          function keydownListener(e: KeyboardEvent) {
            const target = e.target as HTMLElement;
            if (isTextInputLikeElement(target)) {
              return;
            }

            if (e.code === 'Space') {
              e.preventDefault();
              sendBack('LOCK');
            }
          }

          window.addEventListener('keydown', keydownListener);
          return () => {
            window.removeEventListener('keydown', keydownListener);
          };
        },
        invokeDetectRelease: () => (sendBack) => {
          function keyupListener(e: KeyboardEvent) {
            if (e.code === 'Space') {
              e.preventDefault();
              sendBack('RELEASE');
            }
          }

          window.addEventListener('keyup', keyupListener);
          return () => {
            window.removeEventListener('keyup', keyupListener);
          };
        },
      },
    }),
  );

  useEffect(() => {
    if (state.hasTag('dragging')) {
      canvasService.send(
        canvasModel.events.PAN(state.context.dx, state.context.dy),
      );
    }
  }, [state, canvasService]);

  /**
   * Observes the canvas's size and reports it to the canvasService
   */
  useEffect(() => {
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];

      if (!entry) return;

      canvasService.send({
        type: 'CANVAS_RECT_CHANGED',
        height: entry.contentRect.height,
        width: entry.contentRect.width,
        offsetX: entry.contentRect.left,
        offsetY: entry.contentRect.top,
      });
    });

    resizeObserver.observe(canvasRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [canvasService]);

  /**
   * Tracks Wheel Event on canvas
   */
  useEffect(() => {
    const onCanvasWheel = (e: WheelEvent) => {
      const isWithMetaKey = isWithPlatformMetaKey(e);

      if (isWithMetaKey) {
        e.preventDefault();
      }

      const isEmbeddedWithoutZoom =
        isWithMetaKey && embed?.isEmbedded && !embed.zoom;
      const isEmbeddedWithoutPan =
        !isWithMetaKey && embed?.isEmbedded && !embed.pan;

      if (isEmbeddedWithoutPan || isEmbeddedWithoutZoom) {
        return;
      }

      if (isWithMetaKey) {
        if (e.deltaY > 0) {
          canvasService.send(
            canvasModel.events['ZOOM.OUT'](
              e.clientX,
              e.clientY,
              ZoomFactor.slow,
            ),
          );
        } else if (e.deltaY < 0) {
          canvasService.send(
            canvasModel.events['ZOOM.IN'](
              e.clientX,
              e.clientY,
              ZoomFactor.slow,
            ),
          );
        }
      } else if (!e.metaKey && !e.ctrlKey) {
        canvasService.send(canvasModel.events.PAN(e.deltaX, e.deltaY));
      }
    };

    const canvasEl = canvasRef.current;
    canvasEl.addEventListener('wheel', onCanvasWheel);
    return () => {
      canvasEl.removeEventListener('wheel', onCanvasWheel);
    };
  }, [canvasService]);

  return (
    <div
      ref={canvasRef}
      style={{
        cursor: getCursorByState(state),
        WebkitFontSmoothing: 'auto',
      }}
      onPointerDown={(e) => {
        if (state.nextEvents.includes('GRAB')) {
          e.currentTarget.setPointerCapture(e.pointerId);
          send({ type: 'GRAB', point: { x: e.pageX, y: e.pageY } });
        }
      }}
      onPointerMove={(e) => {
        if (state.nextEvents.includes('DRAG')) {
          send({ type: 'DRAG', point: { x: e.pageX, y: e.pageY } });
        }
      }}
      onPointerUp={() => {
        if (state.nextEvents.includes('UNGRAB')) {
          send('UNGRAB');
        }
      }}
    >
      {children}
    </div>
  );
};
