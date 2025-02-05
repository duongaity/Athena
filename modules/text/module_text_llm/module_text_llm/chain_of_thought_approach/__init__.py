from pydantic import BaseModel, Field
from typing import Literal
from llm_core.models import ModelConfigType, MiniModelConfig

from module_text_llm.approach_config import ApproachConfig
from module_text_llm.chain_of_thought_approach.prompt_generate_feedback import CoTGenerateSuggestionsPrompt
from module_text_llm.chain_of_thought_approach.prompt_thinking import ThinkingPrompt

class ChainOfThoughtConfig(ApproachConfig):
    # Defaults to the cheaper mini 4o model
    type: Literal['chain_of_thought'] = 'chain_of_thought'
    model: ModelConfigType = Field(default=MiniModelConfig)  # type: ignore
    thikning_prompt: ThinkingPrompt = Field(default=ThinkingPrompt())
    generate_suggestions_prompt: CoTGenerateSuggestionsPrompt = Field(default=CoTGenerateSuggestionsPrompt())
    